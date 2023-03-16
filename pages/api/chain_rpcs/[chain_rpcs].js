import { fetcher, populateChain, arrayMove } from "../../../utils/fetch";
import { llamaNodesRpcs } from "../../../constants/llamaNodesRpcs";
//import useRPCData from "../../../hooks/useRPCData";
import { useLlamaNodesRpcData } from "../../../hooks/useLlamaNodesRpcData";
import axios from "axios";

const refetchInterval = 60_000;
const defaultTimeout = 1_000;

export const rpcBody = JSON.stringify({
  jsonrpc: "2.0",
  method: "eth_getBlockByNumber",
  params: ["latest", false],
  id: 1,
});

const fetchChain = async (baseURL, timeout = 0) => {
  if (baseURL.includes("API_KEY")) return null;
  try {
    let API = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (timeout !== 0) {
      API.defaults.timeout = timeout;
    }

    API.interceptors.request.use(function (request) {
      request.requestStart = Date.now();
      return request;
    });

    API.interceptors.response.use(
      function (response) {
        response.latency = Date.now() - response.config.requestStart;
        return response;
      },
      function (error) {
        if (error.response) {
          error.response.latency = null;
        }

        return Promise.reject(error);
      },
    );

    let { data, latency } = await API.post("", rpcBody);

    return { ...data, latency };
  } catch (error) {
    return null;
  }
};

const formatData = (url, data) => {
  let height = data?.result?.number ?? null;
  let latency = data?.latency ?? null;
  if (height) {
    const hexString = height.toString(16);
    height = parseInt(hexString, 16);
  } else {
    latency = null;
  }
  return { url, height, latency };
};

const useHttpQuery = (url, timeout = 0) => {
  return {
    queryKey: [url],
    queryFn: () => fetchChain(url, timeout),
    refetchInterval,
    //select: useCallback((data) => formatData(url, data), []),
  };
};

function createPromise() {
  let resolve, reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  promise.resolve = resolve;
  promise.reject = reject;

  return promise;
}

const fetchWssChain = async (baseURL, timeout = 0) => {
  try {
    // small hack to wait until socket connection opens to show loading indicator on table row
    const queryFn = createPromise();

    const socket = new WebSocket(baseURL);
    let requestStart;

    socket.onopen = function () {
      socket.send(rpcBody);
      requestStart = Date.now();
    };

    socket.onmessage = function (event) {
      const data = JSON.parse(event.data);

      const latency = Date.now() - requestStart;
      queryFn.resolve({ ...data, latency });
    };

    socket.onerror = function (e) {
      queryFn.reject(e);
    };

    return await queryFn;
  } catch (error) {
    return null;
  }
};

const useSocketQuery = (url, timeout = 0) => {
  return {
    queryKey: [url],
    queryFn: () => fetchWssChain(url, timeout),
    //select: useCallback((data) => formatData(url, data), []),
    refetchInterval,
  };
};

const getRPCResults = async (urls, timeout = defaultTimeout) => {
  const queries =
    urls?.map((url) => (url.url.indexOf("http") < 0 ? useSocketQuery(url.url, timeout) : useHttpQuery(url.url, timeout))) ?? [];

  const promises = [];
  for (const q of queries) {
    promises.push(q.queryFn(q.queryKey[0], timeout));
  }

  const workingRpcs = [];
  const notWorkingRpcs = [];

  const results = await Promise.all(promises);
  for (let i = 0; i < results.length; i++) {
    if (results[i] != null) {
      results[i].rpc = urls[i];
      results[i].success = true;
      workingRpcs.push(results[i]);
    } else {
      results[i] = { rpc: urls[i], success: false };
      notWorkingRpcs.push(results[i]);
    }
  }

  return {
    allRpcs: results,
    workingRpcs: workingRpcs,
    notWorkingRpcs: notWorkingRpcs
  };
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const { chain_rpcs: chainIdOrName } = req.query;

  //return res.status(404).json({ message: req.query });

  if (req.method === "GET") {
    const chains = await fetcher("https://chainid.network/chains.json");

    let chain = chains.find((chain) => chain.chainId.toString() === chainIdOrName || chain.shortName === chainIdOrName);
    if (!chain) {
      return res.status(404).json({ message: "chain not found" });
    }

    chain = populateChain(chain, []);

    const llamaNodesRpc = llamaNodesRpcs[chain.chainId] ?? null;

    if (llamaNodesRpc) {
      const llamaNodesRpcIndex = chain.rpc.findIndex((rpc) => rpc.url === llamaNodesRpc.rpcs[0].url);

      if (llamaNodesRpcIndex || llamaNodesRpcIndex === 0) {
        chain.rpc = arrayMove(chain.rpc, llamaNodesRpcIndex, 0);
      }
    }

    const results = await getRPCResults(chain.rpc, defaultTimeout);

    return res.status(200).json(results);
  }
}
