import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import {
  parseGraphqlBody,
  getFirstGraphqlOperation,
} from '../helpers/graphqlHelpers'
import {
  onRequestFinished,
  onBeforeRequest,
  onBeforeSendHeaders,
  getHAR,
} from '../services/networkMonitor'
import {
  IIncompleteNetworkRequest,
  INetworkRequest,
  getRequestBody,
  isRequestComplete,
  matchWebAndNetworkRequest,
} from '../helpers/networkHelpers'
import useLatestState from './useLatestState'

export interface IClearWebRequestsOptions {
  clearPending?: boolean
  clearAll?: boolean
}

/**
 * Validate that a network request is a valid graphql request
 * by checking the request body for a valid graphql operation
 *
 */
const validateNetworkRequest = async (
  details: chrome.devtools.network.Request
) => {
  try {
    const body = await getRequestBody(details)
    if (!body) {
      return false
    }

    const graphqlRequestBody = parseGraphqlBody(body)
    if (!graphqlRequestBody) {
      return false
    }

    const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
    if (!primaryOperation) {
      return false
    }
  } catch (error) {
    console.error('Error validating network request', error)
    return false
  }

  return true
}

/**
 * Produce a section of the full INetworkRequest object
 * from the details and responseBody of a chrome.devtools.network.Request
 *
 * @param details
 * @param responseBody the response body of the request.getContent callback
 */
const processNetworkRequest = (
  details: chrome.devtools.network.Request,
  responseBody: string
) => {
  return {
    status: details.response.status,
    url: details.request.url,
    time: details.time === -1 || !details.time ? 0 : details.time,
    method: details.request.method,
    response: {
      headers: details.response.headers,
      headersSize: details.response.headersSize,
      body: responseBody,
      bodySize:
        details.response.bodySize === -1
          ? details.response._transferSize || 0
          : details.response.bodySize,
    },
  }
}

/**
 * Match a network request to a webRequest
 *
 * @param webRequests
 * @param details
 * @returns
 */
const findMatchingWebRequest = async (
  webRequests: IIncompleteNetworkRequest[],
  details: chrome.devtools.network.Request
) => {
  const match = await Promise.all(
    webRequests
      // Don't target requests that already have a response
      .filter((webRequest) => !webRequest.response)
      .map(async (webRequest) => {
        const isMatch = await matchWebAndNetworkRequest(
          details,
          webRequest.native?.webRequest,
          webRequest.request?.headers || []
        )
        return isMatch ? webRequest : null
      })
  )
  return match.filter((r) => r)[0]
}

export const useNetworkMonitor = (): [
  INetworkRequest[],
  (opts?: IClearWebRequestsOptions) => void
] => {
  const [webRequests, setWebRequests, getLatestWebRequests] = useLatestState<
    IIncompleteNetworkRequest[]
  >([])

  const handleBeforeRequest = useCallback(
    (details: chrome.webRequest.WebRequestBodyDetails) => {
      setWebRequests((webRequests) => {
        const newWebRequest: IIncompleteNetworkRequest = {
          id: details.requestId,
          status: -1,
          url: details.url,
          time: 0,
          method: details.method,
          native: {
            webRequest: details,
          },
        }

        return webRequests.concat(newWebRequest)
      })
    },
    [setWebRequests]
  )

  const handleBeforeSendHeaders = useCallback(
    async (details: chrome.webRequest.WebRequestHeadersDetails) => {
      const webRequests = getLatestWebRequests()

      const webRequest = webRequests.find(
        (webRequest) => webRequest.id === details.requestId
      )
      if (!webRequest) {
        return
      }

      // Don't overwrite the request if it's already complete
      if (webRequest.response) {
        return webRequest
      }

      // Now we have both the headers and the body from the webRequest api
      // we can determine if this is a graphql request.
      //
      // If it is not, we return an empty array so flatMap will remove it.
      const body = await getRequestBody(
        webRequest.native.webRequest,
        details.requestHeaders || []
      )

      if (!body) {
        return
      }

      const graphqlRequestBody = parseGraphqlBody(body)
      if (!graphqlRequestBody) {
        return
      }

      const primaryOperation = getFirstGraphqlOperation(graphqlRequestBody)
      if (!primaryOperation) {
        return
      }

      const request = {
        primaryOperation,
        body: graphqlRequestBody.map((requestBody) => ({
          ...requestBody,
          id: uuid(),
        })),
        bodySize: body ? body.length : 0,
        headers: details.requestHeaders,
        headersSize: (details.requestHeaders || []).reduce(
          (acc, header) =>
            acc + header.name.length + (header.value?.length || 0),
          0
        ),
      }

      setWebRequests((prevWebRequests) => {
        return prevWebRequests.map((prevWebRequest) => {
          if (prevWebRequest.id === webRequest.id) {
            return {
              ...prevWebRequest,
              request,
            }
          } else {
            return prevWebRequest
          }
        })
      })
    },
    [setWebRequests, getLatestWebRequests]
  )

  const handleRequestFinished = useCallback(
    (details: chrome.devtools.network.Request) => {
      if (!validateNetworkRequest(details)) {
        return
      }

      details.getContent(async (responseBody) => {
        const webRequests = getLatestWebRequests()
        const matchingWebRequest = await findMatchingWebRequest(
          webRequests,
          details
        )
        if (!matchingWebRequest) {
          return
        }

        setWebRequests((prevWebRequests) => {
          return prevWebRequests.map((prevWebRequest) => {
            if (prevWebRequest.id === matchingWebRequest.id) {
              return {
                ...prevWebRequest,
                id: prevWebRequest.id,
                ...processNetworkRequest(details, responseBody),
              }
            } else {
              return prevWebRequest
            }
          })
        })
      })
    },
    [setWebRequests, getLatestWebRequests]
  )

  const handleHAREntries = useCallback(
    async (entries: chrome.devtools.network.Request[]) => {
      const validEntries = entries.filter((details) => {
        return 'getContent' in details && validateNetworkRequest(details)
      })

      const entriesWithContent = await Promise.all(
        validEntries.map((details) => {
          return new Promise<INetworkRequest>((resolve) => {
            details.getContent(async (responseBody) => {
              const body = await getRequestBody(details)
              if (!body) {
                return
              }

              const graphqlRequestBody = parseGraphqlBody(body)
              if (!graphqlRequestBody) {
                return
              }

              const primaryOperation =
                getFirstGraphqlOperation(graphqlRequestBody)
              if (!primaryOperation) {
                return
              }

              resolve({
                id: uuid(),
                ...processNetworkRequest(details, responseBody),
                request: {
                  primaryOperation,
                  body: graphqlRequestBody.map((requestBody) => ({
                    ...requestBody,
                    id: uuid(),
                  })),
                  bodySize: body ? body.length : 0,
                  headers: details.request.headers,
                  headersSize: details.request.headersSize,
                },
                native: {
                  webRequest: {} as any,
                },
              })
            })
          })
        })
      )

      setWebRequests(entriesWithContent)
    },
    [setWebRequests]
  )

  const clearWebRequests = useCallback(
    (opts?: IClearWebRequestsOptions) => {
      const { clearPending = true, clearAll = true } = opts || {}

      if (clearAll) {
        setWebRequests([])
        return
      }

      if (clearPending) {
        setWebRequests((webRequests) => {
          return webRequests.filter(
            (webRequest) => typeof webRequest.response !== 'undefined'
          )
        })
      }
    },
    [setWebRequests]
  )

  // Collect historic network data in case any events fired before we started listening
  useEffect(() => {
    const fetchHistoricWebRequests = async () => {
      const HARLog = await getHAR()
      handleHAREntries(HARLog.entries as chrome.devtools.network.Request[])
    }

    clearWebRequests()
    fetchHistoricWebRequests()
  }, [handleHAREntries, clearWebRequests])

  // Setup listeners for network data
  useEffect(() => {
    return onBeforeRequest(handleBeforeRequest)
  }, [handleBeforeRequest])

  useEffect(() => {
    return onBeforeSendHeaders(handleBeforeSendHeaders)
  }, [handleBeforeSendHeaders])

  useEffect(() => {
    return onRequestFinished(handleRequestFinished)
  }, [handleRequestFinished])

  // Only return webRequests where the request portion is complete.
  // Since we build up the data from multiple events. We only want
  // to display results that have enough data to be useful.
  const completeWebRequests = webRequests.filter(isRequestComplete)

  // @ts-ignore
  // Ignored as completeWebRequests is readonly. Need to update type
  // across app.
  return [completeWebRequests, clearWebRequests] as const
}
