'use strict';

/**
 * The v1 route table: every v1 route as data, registered by routeBuilder.
 *
 * A route names its handler as `<module under services/>#<function>`, the
 * capabilities it reads (`needs`) or why it reads none (`none`), its guards and
 * its cache. routeBuilder registers guards, then the capability gate, then the
 * cache, then the handler, and loads a handler's module on the route's first
 * call.
 *
 * v1 is frozen: a route here keeps its method, path and answer.
 */

// What the daemon RPC proxies read.
const DAEMON = ['daemonReachable'];
// The app registry: the listed apps and their specs.
const APP_REGISTRY = ['appRegistryConsistent'];
// Where apps run, install and fail to install.
const APP_STATE = ['appStateSynced'];
// Address history the explorer scans.
const EXPLORER = ['explorerSynced'];
// Pricing, entitlement and submission read the live row for name conflicts,
// update authority and the update quote.
const PRICING = ['appRegistryConsistent', 'explorerSynced', 'chainStateConsistent'];
// The quorum grant journal and the founding records live in the local database.
const LOCAL_DB = ['localDbPrepared'];

// Why a route reads no capability.
const NONE = Object.freeze({
  PROCESS: "answers from this process's own state",
  OWN_ANSWER: 'reads stores no capability owns, and answers its own failure',
  PROXY: 'forwards to another program on this node and answers that program\'s failure',
  PEER: 'node-to-node; its handler answers its own refusal',
  OPERATOR: 'an operator action, needed while what it restarts, rebuilds or rescans is down',
  PROGRESS: 'reports scan progress, which a caller reads while the scan runs',
  WITHDRAWN: 'withdrawn; answers 410',
});

module.exports = [
  // GET PUBLIC methods
  { method: 'get', path: '/daemon/help/:command?', needs: DAEMON, cache: '1 hour', handler: 'daemonService/daemonServiceControlRpcs#help' }, // accept both help/command and ?command=getinfo. If ommited, default help will be displayed. Other calls works in similar way
  { method: 'get', path: '/daemon/getinfo', needs: DAEMON, handler: 'daemonService/daemonServiceControlRpcs#getInfoAPI' },
  { method: 'get', path: '/daemon/getfluxnodestatus', needs: DAEMON, cache: '60 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeStatusApi' },
  { method: 'get', path: '/daemon/getzelnodestatus', needs: DAEMON, cache: '60 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeStatusApi' }, // DEPRECATED
  { method: 'get', path: '/daemon/listfluxnodes/:filter?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodes' },
  { method: 'get', path: '/daemon/listzelnodes/:filter?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodes' }, // DEPRECATED
  { method: 'get', path: '/daemon/viewdeterministicfluxnodelist/:filter?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodes' },
  { method: 'get', path: '/daemon/viewdeterministiczelnodelist/:filter?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodes' }, // DEPRECATED
  { method: 'get', path: '/daemon/getfluxnodecount', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeCount' },
  { method: 'get', path: '/daemon/getzelnodecount', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeCount' }, // DEPRECATED
  { method: 'get', path: '/daemon/getdoslist', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getDOSList' },
  { method: 'get', path: '/daemon/getstartlist', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#getStartList' },
  { method: 'get', path: '/daemon/fluxnodecurrentwinner', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceFluxnodeRpcs#fluxNodeCurrentWinner' },
  { method: 'get', path: '/daemon/getbestblockhash', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBestBlockHash' },
  { method: 'get', path: '/daemon/getblock/:hashheight?/:verbosity?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockApi' },
  { method: 'get', path: '/daemon/getblockchaininfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockchainInfoAPI' },
  { method: 'get', path: '/daemon/getblockcount', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockCountAPI' },
  { method: 'get', path: '/daemon/getblockdeltas/:hash?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockDeltas' },
  { method: 'get', path: '/daemon/getblockhashes/:high?/:low?/:noorphans?/:logicaltimes?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockHashes' },
  { method: 'get', path: '/daemon/getblockhash/:index?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockHash' },
  { method: 'get', path: '/daemon/getblockheader/:hash?/:verbose?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockHeader' },
  { method: 'get', path: '/daemon/getchaintips', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getChainTipsAPI' },
  { method: 'get', path: '/daemon/getdifficulty', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getDifficulty' },
  { method: 'get', path: '/daemon/getmempoolinfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getMempoolInfo' },
  { method: 'get', path: '/daemon/getrawmempool/:verbose?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getRawMemPool' },
  { method: 'get', path: '/daemon/gettxout/:txid?/:n?/:includemempool?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getTxOut' },
  { method: 'get', path: '/daemon/gettxoutproof/:txids?/:blockhash?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getTxOutProof' }, // comma separated list of txids. For example: /gettxoutproof/abc,efg,asd/blockhash
  { method: 'get', path: '/daemon/gettxoutsetinfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getTxOutSetInfo' },
  { method: 'get', path: '/daemon/verifytxoutproof/:proof?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#verifyTxOutProof' },
  { method: 'get', path: '/daemon/getspentinfo/:txid?/:index?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBlockchainRpcs#getSpentInfo' },
  { method: 'get', path: '/daemon/getblocksubsidy/:height?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getBlockSubsidy' },
  { method: 'get', path: '/daemon/getblocktemplate/:jsonrequestobject?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getBlockTemplate' },
  { method: 'get', path: '/daemon/getlocalsolps', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getLocalSolPs' },
  { method: 'get', path: '/daemon/getmininginfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getMiningInfo' },
  { method: 'get', path: '/daemon/getnetworkhashps/:blocks?/:height?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getNetworkHashPs' },
  { method: 'get', path: '/daemon/getnetworksolps/:blocks?/:height?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceMiningRpcs#getNetworkSolPs' },
  { method: 'get', path: '/daemon/getconnectioncount', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#getConnectionCount' },
  { method: 'get', path: '/daemon/getdeprecationinfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#getDeprecationInfo' },
  { method: 'get', path: '/daemon/getnettotals', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#getNetTotals' },
  { method: 'get', path: '/daemon/getnetworkinfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#getNetworkInfo' },
  { method: 'get', path: '/daemon/getpeerinfo', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#getPeerInfo' },
  { method: 'get', path: '/daemon/listbanned', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceNetworkRpcs#listBanned' },
  { method: 'get', path: '/daemon/createrawtransaction/:transactions?/:addresses?/:locktime?/:expiryheight?', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#createRawTransaction' },
  { method: 'get', path: '/daemon/decoderawtransaction/:hexstring?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceTransactionRpcs#decodeRawTransaction' },
  { method: 'get', path: '/daemon/decodescript/:hex?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceTransactionRpcs#decodeScript' },
  { method: 'get', path: '/daemon/getrawtransaction/:txid?/:verbose?', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#getRawTransactionAPI' },
  { method: 'get', path: '/daemon/sendrawtransaction/:hexstring?/:allowhighfees?', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#sendRawTransaction' },
  { method: 'get', path: '/daemon/getaddresstxids/:address?/:start?/:end?', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getSingleAddresssTxidsAPI' },
  { method: 'get', path: '/daemon/getaddressbalance/:address?', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getSingleAddressBalanceAPI' },
  { method: 'get', path: '/daemon/getaddressdeltas/:address?/:start?/:end?/:chaininfo?', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getSingleAddressDeltas' },
  { method: 'get', path: '/daemon/getaddressutxos/:address?/:chaininfo?', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getSingleAddressUtxosAPI' },
  { method: 'get', path: '/daemon/getaddressmempool/:address?', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getSingleAddressMempool' },
  { method: 'get', path: '/daemon/createmultisig/:n?/:keys?', needs: DAEMON, handler: 'daemonService/daemonServiceUtilityRpcs#createMultiSig' },
  { method: 'get', path: '/daemon/estimatefee/:nblocks?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceUtilityRpcs#estimateFee' },
  { method: 'get', path: '/daemon/estimatepriority/:nblocks?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceUtilityRpcs#estimatePriority' },
  { method: 'get', path: '/daemon/validateaddress/:fluxaddress?', needs: DAEMON, handler: 'daemonService/daemonServiceUtilityRpcs#validateAddress' },
  { method: 'get', path: '/daemon/verifymessage/:fluxaddress?/:signature?/:message?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceUtilityRpcs#verifyMessage' },
  { method: 'get', path: '/daemon/zvalidateaddress/:zaddr?', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceUtilityRpcs#zValidateAddress' },
  { method: 'get', path: '/daemon/getbenchmarks', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBenchmarkRpcs#getBenchmarks' },
  { method: 'get', path: '/daemon/getbenchstatus', needs: DAEMON, cache: '30 seconds', handler: 'daemonService/daemonServiceBenchmarkRpcs#getBenchStatus' },
  { method: 'get', path: '/id/loginphrase', none: NONE.OWN_ANSWER, handler: 'idService#loginPhrase' },
  { method: 'get', path: '/id/emergencyphrase', none: NONE.OWN_ANSWER, handler: 'idService#emergencyPhrase' },
  { method: 'get', path: '/zelid/loginphrase', none: NONE.OWN_ANSWER, handler: 'idService#loginPhrase' }, // DEPRECATED
  { method: 'get', path: '/zelid/emergencyphrase', none: NONE.OWN_ANSWER, handler: 'idService#emergencyPhrase' }, // DEPRECATED
  { method: 'get', path: '/flux/nodetier', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getNodeTier' },
  { method: 'get', path: '/flux/info', none: NONE.PROCESS, cache: '60 seconds', handler: 'fluxService#getFluxInfoAPI' },
  // Uncached: the answer depends on who is asking.
  { method: 'get', path: '/flux/uplink', guards: ['rejectQueryParameters'], none: NONE.PROCESS, handler: 'uplinkService#uplinkAPI' },
  { method: 'get', path: '/flux/timezone', none: NONE.PROCESS, handler: 'fluxService#getFluxTimezoneAPI' },
  { method: 'get', path: '/flux/version', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxVersionAPI' },
  { method: 'get', path: '/flux/nodejsversions', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getNodeJsVersionsAPI' },
  { method: 'get', path: '/flux/ip', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxIPAPI' },
  { method: 'get', path: '/flux/staticip', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#isStaticIPapi' },
  { method: 'get', path: '/flux/geolocation', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxGeolocation' },
  { method: 'get', path: '/flux/zelid', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxZelIDAPI' }, // DEPERCATED
  { method: 'get', path: '/flux/id', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxZelIDAPI' },
  { method: 'get', path: '/flux/fluxids', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxIds' },
  { method: 'get', path: '/flux/pgp', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxService#getFluxPGPidentityAPI' },
  { method: 'get', path: '/flux/routerip', none: NONE.PROCESS, cache: '1 day', handler: 'fluxService#getRouterIP' },
  { method: 'get', path: '/flux/apiport', none: NONE.PROCESS, cache: '1 day', handler: 'fluxService#getAPIPort' },
  // Withdrawn, answering 410 rather than 404 so a caller learns the list moved
  // instead of reading a dead path as a broken node. Their setters answer the same
  // way beside adjustapiport below.
  { method: 'get', path: '/flux/kadena', none: NONE.PROCESS, handler: 'fluxService#getFluxKadena' },
  { method: 'get', path: '/flux/enterpriseappowners', needs: ['policyVerified'], cache: '1 hour', handler: 'fluxService#getEnterpriseAppOwners' },
  { method: 'get', path: '/flux/marketplaceurl', none: NONE.PROCESS, cache: '1 day', handler: 'fluxService#getMarketplaceURL' },
  { method: 'get', path: '/flux/restart', none: NONE.OPERATOR, handler: 'fluxService#restartFluxOS' },
  { method: 'get', path: '/flux/dosstate', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#getDOSState' },
  { method: 'get', path: '/flux/health', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'idService#nodeHealth' },
  { method: 'post', path: '/flux/dosstate', none: NONE.PROCESS, handler: 'fluxNetworkHelper#setDOSStateApi' },
  // New peer endpoints
  { method: 'get', path: '/flux/peers/:filter?', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxCommunication#getPeers' },
  { method: 'get', path: '/flux/unstablenodes', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxCommunication#getUnstableNodes' },
  { method: 'get', path: '/flux/peerhistory', none: NONE.PROCESS, handler: 'fluxCommunication#getPeerHistory' },
  { method: 'get', path: '/flux/topology', none: NONE.PROCESS, cache: '5 seconds', handler: 'fluxCommunication#getTopology' },
  { method: 'get', path: '/flux/networkhealth', none: NONE.PROCESS, cache: '5 seconds', handler: 'fluxCommunication#getNetworkHealth' },
  // Deprecated peer endpoints — kept for backward compatibility
  { method: 'get', path: '/flux/connectedpeers', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxCommunication#connectedPeers' },
  { method: 'get', path: '/flux/connectedpeersinfo', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxCommunication#connectedPeersInfoAPI' },
  { method: 'get', path: '/flux/incomingconnections', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#getIncomingConnections' },
  { method: 'get', path: '/flux/incomingconnectionsinfo', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#getIncomingConnectionsInfoAPI' },
  { method: 'get', path: '/flux/checkfluxavailability/:ip?/:port?', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#checkFluxAvailability' },
  { method: 'post', path: '/flux/checkappavailability', none: NONE.PROCESS, handler: 'fluxNetworkHelper#checkAppAvailability' },
  { method: 'post', path: '/flux/keepupnpportsopen', none: NONE.PROCESS, handler: 'fluxNetworkHelper#keepUPNPPortsOpen' },
  // POST because the ask carries a signature, which makes it a body and not a
  // URL. No cache() follows from that: apicache keys on the URL alone, so it
  // would answer every different ask alike and answer it before the handler ran
  // - and it caches only GETs regardless. portsInUse caches the value instead.
  // No rejectQueryParameters, because with the ask in the body there is no URL
  // surface for a query string to reach.
  //
  // What this endpoint is for, who may call it and why it is signed is on
  // portsInUseApi, with the code that enforces it.
  { method: 'post', path: '/flux/portsinuse', none: NONE.PEER, handler: 'appNetwork/portManager#portsInUseApi' },

  // ArcaneOS Authentication Endpoints (HTTPS only)
  { method: 'get', path: '/arcane/authchallenge', guards: ['requireHttps'], none: NONE.OWN_ANSWER, handler: 'arcaneAuthService#authChallengeHandler' },

  // Apps routes - now directly calling modular services
  //
  // Several names below say "apps" and mean something else. listrunningapps and
  // listallapps return CONTAINERS, listappsimages returns IMAGES, and each repeats
  // "apps" inside a path that is already under /apps. The names are wrong and are
  // left wrong deliberately: renaming a v1 route is a 404 for every caller, which is
  // a different and louder break than changing what a response contains, and v2 gets
  // the correct names for free in a new URL space. Do not rename them here.
  //
  // Both container listings are public and answer every caller identically, with
  // {Names, State, Status} built from docker's own fields - which is what lets
  // them keep a cache that answers before any handler runs.
  //
  // Not a filter of listallapps, whatever the name says. This answers "which containers
  // should FDM route to", which is the running ones PLUS any stopped container whose app
  // is mid-backup or mid-restore - a fact that lives in this process's memory and is not
  // on the container, so no caller can derive this list from the one below. FDM's
  // checkAppRunning reads it for every app and matches on Names[0] alone, so dropping a
  // container from here takes that app out of routing.
  { method: 'get', path: '/apps/listrunningapps', none: NONE.OWN_ANSWER, cache: '15 seconds', handler: 'appQuery/appQueryService#listRunningAppsAPI' },
  // Read by peers mid-election. Both are unauthenticated, and the API has no rate
  // limiting, so neither may do unbounded backend work per request.
  //
  // heldcomponents still lists docker containers: a component's commitment is
  // in-memory and a FluxOS restart drops it while the container keeps running, so
  // docker is the only thing that answers for a primary that outlived the process
  // holding its intent. Cached at one second - long enough to bound an anonymous
  // caller to one docker call a second, short enough to be meaningless against the
  // tens of seconds this exists to cover. The cache keys on the request URL, so
  // that bound holds only while the URL is the endpoint and nothing else: without
  // the guard a caller varies a parameter and every request is a fresh miss.
  { method: 'get', path: '/apps/heldcomponents', guards: ['rejectQueryParameters'], none: NONE.OWN_ANSWER, cache: '1 second', handler: 'appQuery/appQueryService#heldComponents' },
  // promotedfolders needs no cache: it is served from the set the syncthing monitor
  // already refreshes each pass, so the request touches nothing. Guarded on the
  // same terms as its neighbour - it takes no parameters either, and the two are
  // read by the same callers on the same path.
  { method: 'get', path: '/apps/promotedfolders', guards: ['rejectQueryParameters'], none: NONE.OWN_ANSWER, handler: 'appQuery/appQueryService#promotedFolders' },
  // The same answer with what each receive-only folder HOLDS, which is a size and a
  // last-write time per app and therefore the tenant's. A caller signs as a node on the
  // deterministic list, or holds Flux team privilege; one that does neither is answered
  // without it rather than refused, because a peer too old to sign is not doing anything
  // wrong. POST because a signature needs a body to be over.
  // Refused, at once, until this node holds the node list: establishing who the
  // caller is reads it, and the accessors for it WAIT for it to arrive - a request
  // parked there on a peer's monitor pass teaches the peer nothing until its own
  // probe expires, which it reads as this node being gone rather than starting. The
  // open answer cannot say "not yet": its `ready` is syncthing's first pass, so a
  // peer would read it as this node holding nothing.
  { method: 'post', path: '/apps/promotedfolders', needs: ['nodeListPopulated'], handler: 'appQuery/appQueryService#promotedFolderHoldings' },
  { method: 'get', path: '/apps/listallapps', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/appQueryService#listAllAppsApi' },
  // Answers the flux team, so it takes no cache: apicache keys an entry on the
  // request URL alone and serves it before the handler runs, which would hand
  // one authorised answer to every caller after it.
  { method: 'get', path: '/apps/listappsimages', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#listAppsImagesApi' },
  { method: 'get', path: '/apps/installedapps/:appname?', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/appQueryService#installedAppsAPI' },
  { method: 'get', path: '/apps/availableapps', needs: APP_REGISTRY, cache: '30 seconds', handler: 'appDatabase/registryManager#availableAppsAPI' },
  { method: 'get', path: '/apps/fluxusage', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/appQueryService#fluxUsageAPI' },
  { method: 'get', path: '/apps/appsresources', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/resourceQueryService#appsResourcesApi' },
  { method: 'get', path: '/apps/temporarymessages/:hash?', none: NONE.OWN_ANSWER, cache: '5 seconds', handler: 'appMessaging/messageVerifier#getAppsTemporaryMessages' },
  { method: 'get', path: '/apps/permanentmessages/:hash?/:owner?/:appname?', none: NONE.OWN_ANSWER, cache: '2 minutes', handler: 'appMessaging/messageVerifier#getAppsPermanentMessages' },
  { method: 'get', path: '/apps/ingressattestations/byapp/:name', none: NONE.OWN_ANSWER, handler: 'appMessaging/messageVerifier#getIngressAttestationsByApp' },
  { method: 'get', path: '/apps/ingressattestations/:hash?', none: NONE.OWN_ANSWER, handler: 'appMessaging/messageVerifier#getIngressAttestations' },
  { method: 'get', path: '/apps/globalappsspecifications/:hash?/:owner?/:appname?', needs: APP_REGISTRY, cache: '30 seconds', handler: 'appDatabase/registryManager#getGlobalAppsSpecifications' },
  { method: 'get', path: '/apps/latestspecificationversion', none: NONE.OWN_ANSWER, cache: '5 minutes', handler: 'appQuery/appQueryService#getlatestApplicationSpecificationAPI' },
  // Not cached. apicache keys an entry on the URL alone and answers from it
  // before the handler runs, so a privilege-checked route behind one hands the
  // first caller's response to the next without checking them at all. This
  // route's response is also built for one caller in particular - the payload is
  // encrypted to a session key they supply in a header - so there is nothing in
  // it another caller could use even if it were shared.
  { method: 'get', path: '/apps/appspecifications/:appname/:decrypt?', needs: APP_REGISTRY, handler: 'appDatabase/registryManager#getApplicationSpecificationAPI' },
  // Component names and their election mode, for the flux team. Not cached: the
  // answer depends on who is asking, and a shared cache in front of a
  // privilege-checked route serves one caller's answer to the next.
  { method: 'get', path: '/apps/appcomponentnames/:appname?', needs: APP_REGISTRY, handler: 'appDatabase/registryManager#getApplicationComponentNamesAPI' },
  { method: 'get', path: '/apps/appowner/:appname?', needs: APP_REGISTRY, cache: '30 seconds', handler: 'appDatabase/registryManager#getApplicationOwnerAPI' },
  { method: 'get', path: '/apps/apporiginalowner/:appname?', needs: APP_REGISTRY, cache: '30 seconds', handler: 'appQuery/appQueryService#getApplicationOriginalOwner' },
  { method: 'get', path: '/apps/messagescount/:appowner?', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/appQueryService#getAppsMessagesCount' },
  { method: 'get', path: '/apps/hashes', none: NONE.PROGRESS, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppHashesAPI' },
  { method: 'get', path: '/apps/location/:appname?', needs: APP_STATE, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppsLocation' },
  { method: 'get', path: '/apps/locations', needs: APP_STATE, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppsLocations' },
  { method: 'get', path: '/apps/installinglocation/:appname?', needs: APP_STATE, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppInstallingLocation' },
  { method: 'get', path: '/apps/installinglocations', needs: APP_STATE, cache: '30 seconds', handler: 'appQuery/appQueryService#getAppsInstallingLocations' },
  { method: 'get', path: '/apps/installingerrorslocation/:appname?', needs: APP_STATE, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppInstallingErrorsLocation' },
  { method: 'get', path: '/apps/installingerrorslocations', needs: APP_STATE, cache: '30 seconds', handler: 'appDatabase/registryManager#getAppsInstallingErrorsLocations' },
  { method: 'post', path: '/apps/calculateprice', needs: PRICING, handler: 'utils/appSpecHelpers#getAppPriceApi' }, // returns price in flux for both new registration of app and update of app
  { method: 'post', path: '/apps/calculatefiatandfluxprice', needs: PRICING, handler: 'utils/appSpecHelpers#getAppFiatAndFluxPriceApi' }, // returns price in usd and flux for both new registration of app and update of app
  { method: 'get', path: '/apps/whitelistedrepositories', none: NONE.PROCESS, cache: '30 seconds', handler: 'generalService#whitelistedRepositories' }, // deprecated: whitelist retired, always returns []
  { method: 'post', path: '/apps/verifyappregistrationspecifications', needs: PRICING, handler: 'appRequirements/appSubmission#verifyAppRegistrationParameters' }, // returns formatted app specifications
  { method: 'post', path: '/apps/verifyappupdatespecifications', needs: PRICING, handler: 'appRequirements/appSubmission#verifyAppUpdateApi' }, // returns formatted app specifications
  // Per-component image facts (sizes, architectures, rootFs fit) before a spec is
  // registered. Reports where the registration verify above refuses, so an owner
  // can size rootFsGb from a measurement instead of from a rejection. Measuring is
  // serial and registry-paced, so it answers 202 + jobId and the client polls.
  { method: 'post', path: '/apps/imagepreflight', none: NONE.OWN_ANSWER, handler: 'appSecurity/imagePreflight#submitPreflightAPI' },
  // Run an unsigned spec on this node, once, at the resources it declares, so an
  // owner can watch it boot before anything is registered, signed or paid for.
  // The mesh operator surface. Status is the app's connectivity as THIS node
  // sees it (owner and above); the levers mutate trust surfaces — forced
  // certificate renewal, authority rotation, refuse-set edits — and are
  // admin/fluxteam only, enforced in the handlers.
  { method: 'get', path: '/apps/mesh/status/:appname?', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshAppStatusAPI' },
  { method: 'post', path: '/apps/mesh/renewcertificate', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshRenewCertificateAPI' },
  { method: 'post', path: '/apps/mesh/rotationbegin', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshRotationBeginAPI' },
  { method: 'post', path: '/apps/mesh/rotationadopt', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshRotationAdoptAPI' },
  { method: 'post', path: '/apps/mesh/rotationconclude', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshRotationConcludeAPI' },
  { method: 'post', path: '/apps/mesh/refuse', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshRefuseAPI' },
  { method: 'post', path: '/apps/mesh/unrefuse', none: NONE.OWN_ANSWER, handler: 'appMesh/meshOperatorService#meshUnrefuseAPI' },

  // Nothing touches the chain and no other node is told the session exists.
  // Answers 202 + jobId; the run takes minutes, so the client polls.
  { method: 'post', path: '/apps/playground', none: NONE.OWN_ANSWER, handler: 'appPlayground/playgroundService#submitSessionAPI' },
  // Which nodes serve the CALLER today. No parameter: the FluxID comes off the
  // auth header, so the endpoint can only ever answer for whoever asked. Lets a
  // client go straight to a node that will accept its session instead of finding
  // the set by being refused.
  { method: 'get', path: '/apps/playground/servingset', none: NONE.OWN_ANSWER, handler: 'appPlayground/playgroundService#servingSetAPI' },
  // Node-to-node: the tally for one caller lives on one node, and every other node
  // asks it rather than deciding alone. Unauthenticated by design - the request
  // carries a hash of the caller and no credential, so a peer can spend someone's
  // allowance but can never become them. The handler declines any key this node
  // does not actually hold.
  { method: 'post', path: '/flux/limitcounter/reserve', none: NONE.PEER, handler: 'utils/limitCounterController#reserve' },
  { method: 'post', path: '/flux/limitcounter/release', none: NONE.PEER, handler: 'utils/limitCounterController#release' },
  // Node-to-node: the quorum-grant plane. A grant is a WRITE, unlike the tally
  // above, so every ask is signed with the asker's node operator key and must
  // originate from the asker's registered address; the handler declines any
  // committee this node does not sit on. Nothing consumes grants yet — the
  // surface ships inert ahead of its consumers, per the unified plan.
  { method: 'post', path: '/flux/quorumgrant/probe', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#probe' },
  { method: 'post', path: '/flux/quorumgrant/prepare', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#prepare' },
  { method: 'post', path: '/flux/quorumgrant/accept', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#accept' },
  { method: 'post', path: '/flux/quorumgrant/renew', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#renew' },
  { method: 'post', path: '/flux/quorumgrant/release', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#release' },
  // Reclaim an ordinal register by node-down certificate: the ask carries
  // the certificate, the grantor verifies it and marks the row released.
  { method: 'post', path: '/flux/quorumgrant/vacate', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#vacate' },
  // The holder's single-seat committee heal: the recorded grantee proposes
  // remove-dark-add-next-in-walk; the reply carries this grantor's SIGNED
  // acceptance, and a quorum of those is the roster.
  { method: 'post', path: '/flux/quorumgrant/roster', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#roster' },

  // The register is public fact (epoch, grantee) — an unauthenticated read,
  // served even during the grantor's rejoin drain.
  { method: 'get', path: '/flux/quorumgrant/record', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#record' },
  { method: 'get', path: '/flux/quorumgrant/committee', none: NONE.PEER, handler: 'quorumGrant/grantorController#committee' },
  // The founding basis this node photographed for one app anchor — a routing
  // aid for photo-less hosts; every grantor still verifies asks against its
  // own photo, so this read carries no trust. Unauthenticated like record.
  { method: 'get', path: '/flux/quorumgrant/foundingbasis', needs: LOCAL_DB, handler: 'quorumGrant/grantorController#foundingBasis' },
  // Owner-facing: the generation re-roll. The read tells the owner the
  // standing generation; the submission takes an owner-signed record for
  // exactly the next one, broadcasts it, and stores it here first. The
  // zelidauth session authorizes the submission; the record's inner owner
  // signature is what every node verifies for itself.
  { method: 'get', path: '/apps/grantgeneration/:identity/:role', none: NONE.OWN_ANSWER, handler: 'quorumGrant/ownerGenerationController#current' },
  { method: 'post', path: '/apps/grantgeneration', none: NONE.OWN_ANSWER, handler: 'quorumGrant/ownerGenerationController#submit' },

  // Holder-to-holder: the witness poll (what is this node doing about a key,
  // can it reach the committee) and the relay (carry an end-to-end signed ask
  // for an app this node holds). A master's safety never depends on its own
  // committee path because of these two.
  { method: 'post', path: '/flux/quorumgrant/witness', none: NONE.PEER, handler: 'quorumGrant/grantPeerController#witness' },
  { method: 'post', path: '/flux/quorumgrant/relay', none: NONE.PEER, handler: 'quorumGrant/grantPeerController#relay' },
  // The courier's delivery: a new-committee cell carrying the owner's re-roll
  // record to an instance of the app. Owner-verified on the broadcast path;
  // the answer is the generation this node holds afterwards.
  { method: 'post', path: '/flux/quorumgrant/teach', none: NONE.PEER, handler: 'quorumGrant/grantPeerController#teach' },
  { method: 'post', path: '/apps/placementfeasibility', none: NONE.OWN_ANSWER, handler: 'appPlacement/placementFeasibility#placementFeasibilityAPI' }, // fault domains and per-domain instance share for a prospective spec
  { method: 'get', path: '/apps/placementlocations', guards: ['rejectQueryParameters'], none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appPlacement/placementFeasibility#placementLocationsAPI' }, // node, fault-domain and tier counts per continent/country
  { method: 'get', path: '/apps/registrationinformation', none: NONE.WITHDRAWN, handler: 'appDatabase/registryManager#registrationInformation' },
  { method: 'get', path: '/apps/deploymentinformation', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appQuery/deploymentInfoService#deploymentInformation' },
  { method: 'get', path: '/apps/enterprisenodes', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'enterpriseNodesService#getEnterpriseNodesAPI' },
  { method: 'get', path: '/apps/getappspecsusdprice', none: NONE.OWN_ANSWER, cache: '30 minutes', handler: 'appQuery/deploymentInfoService#getAppSpecsUSDPrice' },
  { method: 'get', path: '/apps/tamperingevents/:appname?', none: NONE.OWN_ANSWER, cache: '30 seconds', handler: 'appTamperingDetectionService#getEvents' },
  { method: 'get', path: '/explorer/utxo/:address?', needs: EXPLORER, cache: '30 seconds', handler: 'chainReadApi#getAddressUtxos' },
  { method: 'get', path: '/explorer/transactions/:address?', needs: EXPLORER, cache: '30 seconds', handler: 'chainReadApi#getAddressTransactions' },
  { method: 'get', path: '/explorer/balance/:address?', needs: EXPLORER, cache: '30 seconds', handler: 'chainReadApi#getAddressBalance' },
  { method: 'get', path: '/explorer/fusion/coinbase/:address?', needs: EXPLORER, handler: 'explorerService#getAddressFusionCoinbase' },
  { method: 'get', path: '/explorer/scannedheight', none: NONE.PROGRESS, cache: '30 seconds', handler: 'chainReadApi#getScannedHeightAPI' },

  // GET PROTECTED API - User level
  { method: 'get', path: '/daemon/prioritisetransaction/:txid?/:prioritydelta?/:feedelta?', needs: DAEMON, handler: 'daemonService/daemonServiceMiningRpcs#prioritiseTransaction' },
  { method: 'get', path: '/daemon/submitblock/:hexdata?/:jsonparametersobject?', needs: DAEMON, handler: 'daemonService/daemonServiceMiningRpcs#submitBlock' },
  // Enterprise image cache (owner-scoped; gated to allowed owners on this enterprise node)
  { method: 'get', path: '/apps/imagecache', none: NONE.OWN_ANSWER, handler: 'appManagement/imageCacheController#getImageCacheList' },
  { method: 'get', path: '/apps/imagecache/item', none: NONE.OWN_ANSWER, handler: 'appManagement/imageCacheController#getImageCacheItem' },
  { method: 'get', path: '/id/loggedsessions', none: NONE.OWN_ANSWER, handler: 'idService#loggedSessions' },
  { method: 'get', path: '/id/logoutcurrentsession', none: NONE.OWN_ANSWER, handler: 'idService#logoutCurrentSession' },
  { method: 'get', path: '/id/logoutallsessions', none: NONE.OWN_ANSWER, handler: 'idService#logoutAllSessions' },
  { method: 'get', path: '/zelid/loggedsessions', none: NONE.OWN_ANSWER, handler: 'idService#loggedSessions' }, // DEPRECATED
  { method: 'get', path: '/zelid/logoutcurrentsession', none: NONE.OWN_ANSWER, handler: 'idService#logoutCurrentSession' }, // DEPRECATED
  { method: 'get', path: '/zelid/logoutallsessions', none: NONE.OWN_ANSWER, handler: 'idService#logoutAllSessions' }, // DEPRECATED
  { method: 'get', path: '/benchmark/getstatus', none: NONE.PROXY, cache: '30 seconds', handler: 'benchmarkService#getStatusAPI' },
  { method: 'get', path: '/benchmark/help/:command?', none: NONE.PROXY, cache: '1 hour', handler: 'benchmarkService#help' },
  { method: 'get', path: '/benchmark/getbenchmarks', none: NONE.PROXY, cache: '30 seconds', handler: 'benchmarkService#getBenchmarksAPI' },
  { method: 'get', path: '/benchmark/getstoredbenchmark', none: NONE.PROXY, cache: '1 hour', handler: 'benchmarkService#getStoredBenchmark' },
  { method: 'get', path: '/benchmark/getinfo', none: NONE.PROXY, cache: '30 seconds', handler: 'benchmarkService#getInfoAPI' },
  { method: 'get', path: '/syncthing/deviceid', none: NONE.PROXY, cache: '30 seconds', handler: 'syncthingService#getDeviceIdApi' },
  // BACKUP & RESTORE

  { method: 'get', path: '/backup/getvolumedataofcomponent/:appname?/:component?/:multiplier?/:decimal?/:fields?', none: NONE.OWN_ANSWER, handler: 'backupRestoreService#getVolumeDataOfComponent' },
  { method: 'get', path: '/backup/getremotefilesize/:fileurl?/:multiplier?/:decimal?/:number?/:appname?', none: NONE.OWN_ANSWER, handler: 'backupRestoreService#getRemoteFileSize' },
  { method: 'get', path: '/backup/getlocalbackuplist/:path?/:multiplier?/:decimal?/:number?/:appname?', none: NONE.OWN_ANSWER, handler: 'backupRestoreService#getLocalBackupList' },
  { method: 'get', path: '/backup/removebackupfile/:filepath?/:appname?', none: NONE.OWN_ANSWER, handler: 'backupRestoreService#removeBackupFile' },
  { method: 'get', path: '/backup/downloadlocalfile/:filepath?/:appname?', none: NONE.OWN_ANSWER, handler: 'backupRestoreService#downloadLocalFile' },
  { method: 'post', path: '/apps/appendbackuptask', none: NONE.OWN_ANSWER, handler: 'appLifecycle/appOperations#appendBackupTask' },
  { method: 'post', path: '/apps/appendrestoretask', none: NONE.OWN_ANSWER, handler: 'appLifecycle/appOperations#appendRestoreTask' },
  { method: 'post', path: '/ioutils/fileupload/:type?/:appname?/:component?/:folder?/:filename?', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#uploadAppsFiles' },

  // GET PROTECTED API - Fluxnode Owner
  { method: 'get', path: '/daemon/stop', needs: DAEMON, handler: 'daemonService/daemonServiceControlRpcs#stop' },
  { method: 'get', path: '/daemon/reindex', none: NONE.OPERATOR, handler: 'fluxService#reindexDaemon' },
  { method: 'get', path: '/daemon/createfluxnodekey', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#createFluxNodeKey' },
  { method: 'get', path: '/daemon/createzelnodekey', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#createFluxNodeKey' }, // DEPRECATED
  { method: 'get', path: '/daemon/listfluxnodeconf/:filter?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodeConf' },
  { method: 'get', path: '/daemon/listzelnodeconf/:filter?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#listFluxNodeConf' }, // DEPRECATED
  { method: 'get', path: '/daemon/getfluxnodeoutputs', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeOutputs' },
  { method: 'get', path: '/daemon/getzelnodeoutputs', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#getFluxNodeOutputs' }, // DEPRECATED
  { method: 'get', path: '/daemon/startfluxnode/:set?/:lockwallet?/:alias?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#startFluxNode' },
  { method: 'get', path: '/daemon/startzelnode/:set?/:lockwallet?/:alias?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#startFluxNode' }, // DEPRECATED
  { method: 'get', path: '/daemon/startdeterministicfluxnode/:alias?/:lockwallet?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#startDeterministicFluxNode' },
  { method: 'get', path: '/daemon/startdeterministiczelnode/:alias?/:lockwallet?', needs: DAEMON, handler: 'daemonService/daemonServiceFluxnodeRpcs#startDeterministicFluxNode' }, // DEPRECATED
  { method: 'get', path: '/daemon/verifychain/:checklevel?/:numblocks?', needs: DAEMON, handler: 'daemonService/daemonServiceBlockchainRpcs#verifyChain' },
  { method: 'get', path: '/daemon/addnode/:node?/:command?', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#addNode' },
  { method: 'get', path: '/daemon/clearbanned', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#clearBanned' },
  { method: 'get', path: '/daemon/disconnectnode/:node?', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#disconnectNode' },
  { method: 'get', path: '/daemon/getaddednodeinfo/:dns?/:node?', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#getAddedNodeInfo' },
  { method: 'get', path: '/daemon/setban/:ip?/:command?/:bantime?/:absolute?', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#setBan' },
  { method: 'get', path: '/id/loggedusers', none: NONE.OWN_ANSWER, handler: 'idService#loggedUsers' },
  { method: 'get', path: '/id/activeloginphrases', none: NONE.OWN_ANSWER, handler: 'idService#activeLoginPhrases' },
  { method: 'get', path: '/id/logoutallusers', none: NONE.OWN_ANSWER, handler: 'idService#logoutAllUsers' },
  { method: 'get', path: '/zelid/loggedusers', none: NONE.OWN_ANSWER, handler: 'idService#loggedUsers' }, // DEPRECATED
  { method: 'get', path: '/zelid/activeloginphrases', none: NONE.OWN_ANSWER, handler: 'idService#activeLoginPhrases' }, // DEPRECATED
  { method: 'get', path: '/zelid/logoutallusers', none: NONE.OWN_ANSWER, handler: 'idService#logoutAllUsers' }, // DEPRECATED

  // Withdrawn settings: kept so callers get a reasoned error rather than a 404.
  // Remove at the next major version.
  { method: 'get', path: '/flux/adjustkadena/:account?/:chainid?', none: NONE.OPERATOR, handler: 'fluxService#adjustKadenaAccount' },
  { method: 'get', path: '/flux/adjustrouterip/:routerip?', none: NONE.OPERATOR, handler: 'fluxService#adjustRouterIP' }, // note this essentially rebuilds flux use with caution!
  { method: 'get', path: '/flux/adjustapiport/:apiport?', none: NONE.OPERATOR, handler: 'fluxService#adjustAPIPort' }, // note this essentially rebuilds flux use with caution!
  { method: 'get', path: '/flux/reindexdaemon', none: NONE.OPERATOR, handler: 'fluxService#reindexDaemon' },
  { method: 'get', path: '/benchmark/signfluxnodetransaction/:hexstring?', none: NONE.PROXY, handler: 'benchmarkService#signFluxTransaction' },
  { method: 'get', path: '/benchmark/signzelnodetransaction/:hexstring?', none: NONE.PROXY, handler: 'benchmarkService#signFluxTransaction' }, // DEPRECATED
  { method: 'get', path: '/benchmark/stop', none: NONE.PROXY, handler: 'benchmarkService#stop' },

  // GET PROTECTED API - FluxTeam
  { method: 'get', path: '/daemon/start', none: NONE.OPERATOR, handler: 'fluxService#startDaemon' },
  { method: 'get', path: '/daemon/restart', none: NONE.OPERATOR, handler: 'fluxService#restartDaemon' },
  { method: 'get', path: '/daemon/ping', needs: DAEMON, handler: 'daemonService/daemonServiceNetworkRpcs#ping' }, // we do not want this to be issued by anyone.
  { method: 'get', path: '/daemon/startbenchmark', needs: DAEMON, handler: 'daemonService/daemonServiceBenchmarkRpcs#startBenchmarkD' },
  { method: 'get', path: '/daemon/stopbenchmark', needs: DAEMON, handler: 'daemonService/daemonServiceBenchmarkRpcs#stopBenchmarkD' },
  { method: 'get', path: '/flux/startbenchmark', none: NONE.OPERATOR, handler: 'fluxService#startBenchmark' },
  { method: 'get', path: '/flux/restartbenchmark', none: NONE.OPERATOR, handler: 'fluxService#restartBenchmark' },
  { method: 'get', path: '/flux/startdaemon', none: NONE.OPERATOR, handler: 'fluxService#startDaemon' },
  { method: 'get', path: '/flux/restartdaemon', none: NONE.OPERATOR, handler: 'fluxService#restartDaemon' },
  { method: 'get', path: '/flux/loglevel/:loglevel?', none: NONE.OPERATOR, handler: 'fluxService#adjustLogLevel' },
  // What this node reports it is running, read from the working tree it was deployed
  // from. A diagnostic for whoever switches the branch below, and only that: it is the
  // node's own account of itself, so it answers what is on disk rather than settling
  // whether that is what should be there.
  { method: 'get', path: '/flux/currentbranch', none: NONE.PROCESS, handler: 'fluxService#getCurrentBranchApi' },
  { method: 'get', path: '/flux/currentcommitid', none: NONE.PROCESS, handler: 'fluxService#getCurrentCommitIdApi' },
  { method: 'get', path: '/flux/entermaster', none: NONE.OPERATOR, handler: 'fluxService#enterMasterApi' },
  { method: 'get', path: '/flux/enterdevelopment', none: NONE.OPERATOR, handler: 'fluxService#enterDevelopmentApi' },
  { method: 'get', path: '/flux/updateflux', none: NONE.OPERATOR, handler: 'fluxService#updateFlux' }, // method shall be called only if flux version is obsolete.
  { method: 'get', path: '/flux/softupdateflux', none: NONE.OPERATOR, handler: 'fluxService#softUpdateFluxApi' }, // method shall be called only if flux version is obsolete.
  { method: 'get', path: '/flux/softupdatefluxinstall', none: NONE.OPERATOR, handler: 'fluxService#softUpdateFluxInstallApi' }, // method shall be called only if flux version is obsolete.
  { method: 'get', path: '/flux/hardupdateflux', none: NONE.OPERATOR, handler: 'fluxService#hardUpdateFlux' }, // method shall be called only if flux version is obsolete and updatezeflux is not working correctly
  { method: 'get', path: '/flux/rebuildui', none: NONE.OPERATOR, handler: 'fluxService#rebuildUi' },
  { method: 'get', path: '/flux/updatedaemon', none: NONE.OPERATOR, handler: 'fluxService#updateDaemon' }, // method shall be called only if daemon version is obsolete
  { method: 'get', path: '/flux/updatebenchmark', none: NONE.OPERATOR, handler: 'fluxService#updateBenchmark' }, // method shall be called only if benchamrk version is obsolete
  { method: 'get', path: '/flux/daemondebug', none: NONE.PROCESS, handler: 'fluxService#daemonDebug' },
  { method: 'get', path: '/flux/benchmarkdebug', none: NONE.PROCESS, handler: 'fluxService#benchmarkDebug' },
  { method: 'get', path: '/flux/taildaemondebug', none: NONE.PROCESS, handler: 'fluxService#tailDaemonDebug' },
  { method: 'get', path: '/flux/tailbenchmarkdebug', none: NONE.PROCESS, handler: 'fluxService#tailBenchmarkDebug' },
  { method: 'get', path: '/flux/errorlog', none: NONE.PROCESS, handler: 'fluxService#fluxErrorLog' },
  { method: 'get', path: '/flux/warnlog', none: NONE.PROCESS, handler: 'fluxService#fluxWarnLog' },
  { method: 'get', path: '/flux/debuglog', none: NONE.PROCESS, handler: 'fluxService#fluxDebugLog' },
  { method: 'get', path: '/flux/infolog', none: NONE.PROCESS, handler: 'fluxService#fluxInfoLog' },
  { method: 'get', path: '/flux/tailerrorlog', none: NONE.PROCESS, handler: 'fluxService#tailFluxErrorLog' },
  { method: 'get', path: '/flux/tailwarnlog', none: NONE.PROCESS, handler: 'fluxService#tailFluxWarnLog' },
  { method: 'get', path: '/flux/taildebuglog', none: NONE.PROCESS, handler: 'fluxService#tailFluxDebugLog' },
  { method: 'get', path: '/flux/tailinfolog', none: NONE.PROCESS, handler: 'fluxService#tailFluxInfoLog' },
  { method: 'get', path: '/flux/broadcastmessage/:data?', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageFromUser' },
  { method: 'get', path: '/flux/broadcastmessagetooutgoing/:data?', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageToOutgoingFromUser' },
  { method: 'get', path: '/flux/broadcastmessagetoincoming/:data?', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageToIncomingFromUser' },
  { method: 'get', path: '/flux/addpeer/:ip?', none: NONE.PROCESS, handler: 'fluxCommunication#addPeer' },
  { method: 'get', path: '/flux/removepeer/:ip?', none: NONE.PROCESS, handler: 'fluxCommunication#removePeer' },
  { method: 'get', path: '/flux/addoutgoingpeer/:ip?', none: NONE.PROCESS, handler: 'fluxCommunication#addOutgoingPeer' },
  { method: 'get', path: '/flux/removeincomingpeer/:ip?', none: NONE.PROCESS, handler: 'fluxCommunication#removeIncomingPeer' },
  { method: 'get', path: '/flux/allowport/:port?', none: NONE.PROCESS, handler: 'fluxNetworkHelper#allowPortApi' },
  { method: 'get', path: '/flux/checkcommunication', none: NONE.PROCESS, handler: 'fluxNetworkHelper#isCommunicationEstablishedAPI' },
  { method: 'get', path: '/flux/uptime', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#fluxUptimeAPI' },
  { method: 'get', path: '/flux/systemuptime', none: NONE.PROCESS, cache: '30 seconds', handler: 'fluxNetworkHelper#fluxSystemUptime' },
  { method: 'get', path: '/flux/clockdrift', none: NONE.PROCESS, cache: '30 seconds', handler: 'clockDrift#clockDrift' },
  { method: 'get', path: '/flux/backendfolder', guards: ['isLocal'], none: NONE.PROCESS, handler: 'fluxService#fluxBackendFolder' },
  { method: 'get', path: '/flux/mapport/:port?', none: NONE.PROXY, handler: 'upnpService#mapPortApi' },
  { method: 'get', path: '/flux/unmapport/:port?', none: NONE.PROXY, handler: 'upnpService#removeMapPortApi' },
  { method: 'get', path: '/flux/getmap', none: NONE.PROXY, handler: 'upnpService#getMapApi' },
  { method: 'get', path: '/flux/getip', none: NONE.PROXY, handler: 'upnpService#getIpApi' },
  { method: 'get', path: '/flux/getgateway', none: NONE.PROXY, handler: 'upnpService#getGatewayApi' },
  { method: 'get', path: '/flux/isarcaneos', none: NONE.PROCESS, cache: '1 day', handler: 'fluxService#isArcaneOs' },
  { method: 'get', path: '/benchmark/start', none: NONE.OPERATOR, handler: 'fluxService#startBenchmark' },
  { method: 'get', path: '/benchmark/restart', none: NONE.OPERATOR, handler: 'fluxService#restartBenchmark' },
  { method: 'get', path: '/benchmark/restartnodebenchmarks', none: NONE.PROXY, handler: 'benchmarkService#restartNodeBenchmarks' },
  { method: 'get', path: '/explorer/reindex/:reindexapps?', none: NONE.OPERATOR, handler: 'explorerService#reindexExplorerApi' },
  { method: 'get', path: '/explorer/restart', none: NONE.OPERATOR, handler: 'explorerService#restartBlockProcessingApi' },
  { method: 'get', path: '/explorer/stop', none: NONE.OPERATOR, handler: 'explorerService#stopBlockProcessingApi' },
  { method: 'get', path: '/explorer/rescan/:blockheight?/:rescanapps?', none: NONE.OPERATOR, handler: 'explorerService#rescanExplorerApi' },
  { method: 'get', path: '/apps/updatetolatestspecs/:appname', none: NONE.WITHDRAWN, handler: 'appDatabase/registryManager#updateApplicationSpecificationAPI' },
  { method: 'get', path: '/apps/appconvert/:appname', needs: APP_REGISTRY, handler: 'appDatabase/registryManager#appConvertApi' },
  { method: 'get', path: '/flux/startdiscovery', none: NONE.PROCESS, handler: 'fluxCommunication#startDiscoveryApi' },
  { method: 'get', path: '/flux/eventstream', none: NONE.PROCESS, handler: 'utils/fluxEventBus#sseHandler' },
  { method: 'get', path: '/apps/checkhashes', none: NONE.OPERATOR, handler: 'appMessaging/appHashSyncService#triggerAppHashesCheckAPI' },
  { method: 'get', path: '/apps/requestmessage/:hash', none: NONE.OWN_ANSWER, handler: 'appMessaging/messageVerifier#requestAppMessageAPI' },
  // The eight app-control routes. A 503 from the boot gate cannot collapse into
  // a bodiless 304: express's req.fresh returns false unless the status is 2xx
  // or 304, so a conditional request never turns a 503 into one.
  { method: 'get', path: '/apps/appstart/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appStart' },
  { method: 'get', path: '/apps/appstop/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appStop' },
  { method: 'get', path: '/apps/appyield/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appYieldApi' },
  { method: 'get', path: '/apps/apprestart/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appRestart' },
  // No :global - a kill is deliberately per-node. Its privilege is the same as
  // its siblings' above: every run-state verb asks for appownerorfluxteam, so
  // the node operator can order none of them on an app they only host.
  { method: 'get', path: '/apps/appkill/:appname?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appKill' },
  { method: 'get', path: '/apps/apppause/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appPause' },
  { method: 'get', path: '/apps/appunpause/:appname?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appManagement/appController#appUnpause' },
  { method: 'get', path: '/apps/apptop/:appname?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appTop' },
  { method: 'get', path: '/apps/applog/:appname?/:lines?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appLog' },
  { method: 'get', path: '/apps/applogpolling/:appname?/:lines?/:since?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appLogPolling' },
  { method: 'get', path: '/apps/appinspect/:appname?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appInspect' },
  { method: 'get', path: '/apps/appstats/:appname?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appStats' },
  { method: 'get', path: '/apps/appmonitor/:appname?/:range?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appMonitorAPI' },
  { method: 'get', path: '/apps/appchanges/:appname?', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appChanges' },
  { method: 'post', path: '/apps/appexec', none: NONE.OWN_ANSWER, handler: 'appManagement/appInspector#appExec' },
  { method: 'get', path: '/apps/appremove/:appname?/:force?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided'], handler: 'appLifecycle/appUninstaller#removeAppLocallyApi' },
  { method: 'get', path: '/apps/installapplocally/:appname?', needs: ['bootReconcileDecided', 'policyVerified', 'policyCurrent'], handler: 'appLifecycle/appInstaller#installApplicationAPI' },
  // Tests nothing: it ran apps at fabricated resource limits, so a pass meant
  // nothing. It still answers 200 only because the frontend gates the payment step
  // on this call succeeding; the reply says nothing was installed and names what
  // replaced it. Restore the 410 once the frontend no longer calls it.
  //
  // It reads no capability - the handler installs nothing, and gating it would
  // answer a boot-time caller "not ready" instead of the notice the frontend has
  // to parse to reach payment.
  { method: 'get', path: '/apps/testappinstall/:appname?', none: NONE.OWN_ANSWER, handler: 'appLifecycle/appInstaller#testInstallApplicationAPI' },
  { method: 'get', path: '/apps/createfluxnetwork', none: NONE.OWN_ANSWER, handler: 'appManagement/appController#createFluxNetworkAPI' },
  { method: 'get', path: '/apps/reindexglobalappslocation', none: NONE.OPERATOR, handler: 'appDatabase/registryManager#reindexGlobalAppsLocationAPI' },
  { method: 'get', path: '/apps/redeploy/:appname?/:force?/:global?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided', 'policyVerified', 'policyCurrent'], handler: 'appLifecycle/appOperations#redeployApplicationAPI' },
  { method: 'get', path: '/apps/redeploycomponent/:appname?/:component?/:force?', guards: ['alwaysRespond'], needs: ['bootReconcileDecided', 'policyVerified', 'policyCurrent'], handler: 'appLifecycle/appOperations#redeployComponentAPI' },
  // alwaysRespond, like the other retired routes: the body is byte-identical on
  // every call, so express fingerprints it with a strong ETag and any caller that
  // revalidates gets an empty 304 from the second call on. Explaining why the
  // endpoint stopped working is the only job these routes have left, and a repeat
  // caller could never read the explanation.
  { method: 'get', path: '/apps/startmonitoring/:appname?', guards: ['alwaysRespond'], none: NONE.OWN_ANSWER, handler: 'appMonitoring/monitoringOrchestrator#startAppMonitoringAPI' },
  { method: 'get', path: '/apps/stopmonitoring/:appname?/:deletedata?', guards: ['alwaysRespond'], none: NONE.OWN_ANSWER, handler: 'appMonitoring/monitoringOrchestrator#stopAppMonitoringAPI' },
  { method: 'get', path: '/apps/appmonitorstream/:appname?', guards: ['alwaysRespond'], none: NONE.OWN_ANSWER, handler: 'appMonitoring/monitoringOrchestrator#appMonitorStreamAPI' },
  { method: 'get', path: '/syncthing/metrics', none: NONE.PROXY, handler: 'syncthingService#getSyncthingMetrics' },
  { method: 'get', path: '/syncthing/metrics/health', none: NONE.PROXY, handler: 'syncthingService#getSyncthingHealthSummary' },
  { method: 'get', path: '/syncthing/metrics/history/:limit?', none: NONE.PROXY, handler: 'syncthingService#getSyncthingMetricsHistory' },
  { method: 'get', path: '/syncthing/peer/diagnostics', none: NONE.PROXY, handler: 'syncthingService#getPeerSyncDiagnosticsApi' },

  // POST PUBLIC methods route
  // ArcaneOS Authentication Endpoints (HTTPS only)
  { method: 'post', path: '/arcane/configsync', guards: ['requireHttps'], none: NONE.OWN_ANSWER, handler: 'arcaneAuthService#configSyncHandler' },
  { method: 'post', path: '/id/verifylogin', none: NONE.OWN_ANSWER, handler: 'idService#verifyLogin' },
  { method: 'post', path: '/id/providesign', none: NONE.OWN_ANSWER, handler: 'idService#provideSign' },
  { method: 'post', path: '/id/checkprivilege', none: NONE.OWN_ANSWER, handler: 'idService#checkLoggedUser' },
  { method: 'post', path: '/zelid/verifylogin', none: NONE.OWN_ANSWER, handler: 'idService#verifyLogin' }, // DEPRECATED
  { method: 'post', path: '/zelid/providesign', none: NONE.OWN_ANSWER, handler: 'idService#provideSign' }, // DEPRECATED
  { method: 'post', path: '/zelid/checkprivilege', none: NONE.OWN_ANSWER, handler: 'idService#checkLoggedUser' }, // DEPRECATED

  // The rendezvous a wallet posts to, addressed by the sites that open it.
  { method: 'get', path: '/payment/paymentrequest', none: NONE.OWN_ANSWER, handler: 'paymentRelayService#paymentRequest' },
  { method: 'post', path: '/payment/verifypayment', none: NONE.OWN_ANSWER, handler: 'paymentRelayService#receivePaymentCallback' },
  { method: 'post', path: '/daemon/createrawtransaction', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#createRawTransactionPost' },
  { method: 'post', path: '/daemon/decoderawtransaction', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#decodeRawTransactionPost' },
  { method: 'post', path: '/daemon/decodescript', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#decodeScriptPost' },
  { method: 'post', path: '/daemon/sendrawtransaction', needs: DAEMON, handler: 'daemonService/daemonServiceTransactionRpcs#sendRawTransactionPost' },
  { method: 'post', path: '/daemon/createmultisig', needs: DAEMON, handler: 'daemonService/daemonServiceUtilityRpcs#createMultiSigPost' },
  { method: 'post', path: '/daemon/verifymessage', needs: DAEMON, handler: 'daemonService/daemonServiceUtilityRpcs#verifyMessagePost' },
  { method: 'post', path: '/daemon/getblockhashes', needs: DAEMON, handler: 'daemonService/daemonServiceBlockchainRpcs#getBlockHashesPost' },
  { method: 'post', path: '/daemon/getspentinfo', needs: DAEMON, handler: 'daemonService/daemonServiceBlockchainRpcs#getSpentInfoPost' },
  { method: 'post', path: '/daemon/getaddresstxids', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getAddressTxids' },
  { method: 'post', path: '/daemon/getaddressbalance', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getAddressBalance' },
  { method: 'post', path: '/daemon/getaddressdeltas', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getAddressDeltas' },
  { method: 'post', path: '/daemon/getaddressutxos', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getAddressUtxos' },
  { method: 'post', path: '/daemon/getaddressmempool', needs: DAEMON, handler: 'daemonService/daemonServiceAddressRpcs#getAddressMempool' },
  { method: 'get', path: '/flux/streamchainpreparation', none: NONE.PROCESS, handler: 'fluxService#streamChainPreparation' },
  { method: 'post', path: '/flux/streamchain', none: NONE.PROCESS, handler: 'fluxService#streamChain' },

  // POST PROTECTED API - USER LEVEL
  { method: 'post', path: '/id/logoutspecificsession', none: NONE.OWN_ANSWER, handler: 'idService#logoutSpecificSession' }, // requires the knowledge of a session loginPhrase so users level is sufficient and user cannot logout another user as he does not know the loginPhrase.
  { method: 'post', path: '/zelid/logoutspecificsession', none: NONE.OWN_ANSWER, handler: 'idService#logoutSpecificSession' }, // DEPRECATED
  { method: 'post', path: '/daemon/submitblock', needs: DAEMON, handler: 'daemonService/daemonServiceMiningRpcs#submitBlockPost' },
  { method: 'post', path: '/apps/checkdockerexistance', none: NONE.OWN_ANSWER, handler: 'appSecurity/imageManager#checkDockerAccessibility' },
  { method: 'post', path: '/apps/appregister', needs: PRICING, handler: 'appRequirements/appSubmission#registerAppGlobalyApi' },
  { method: 'post', path: '/apps/appupdate', needs: PRICING, handler: 'appLifecycle/appOperations#updateAppGlobalyApi' },
  { method: 'get', path: '/apps/contentblob/:appName/:locator', none: NONE.OWN_ANSWER, handler: 'appLifecycle/appOperations#contentBlobServeApi' },
  { method: 'post', path: '/apps/contentupdate', needs: APP_REGISTRY, handler: 'appLifecycle/contentSlotService#submitContentUpdateApi' },
  { method: 'get', path: '/apps/contentmanifest/:appname', none: NONE.OWN_ANSWER, handler: 'appLifecycle/contentSlotService#getContentManifestApi' },
  { method: 'get', path: '/apps/contentmanifests/:appname', none: NONE.OWN_ANSWER, handler: 'appLifecycle/contentSlotService#getContentManifestsApi' },
  { method: 'post', path: '/apps/getpublickey', none: NONE.OWN_ANSWER, handler: 'appMessaging/cryptographicKeys#getPublicKey' },
  { method: 'get', path: '/apps/transportpubkey/:appname', none: NONE.OWN_ANSWER, handler: 'appMessaging/cryptographicKeys#getTransportPublicKey' },
  { method: 'post', path: '/apps/bloblocator', none: NONE.OWN_ANSWER, handler: 'appMessaging/cryptographicKeys#getBlobLocator' },
  { method: 'post', path: '/apps/imagecache', none: NONE.OWN_ANSWER, handler: 'appManagement/imageCacheController#postImageCache' },
  { method: 'post', path: '/apps/imagecache/remove', none: NONE.OWN_ANSWER, handler: 'appManagement/imageCacheController#removeImageCache' },

  // POST PROTECTED API - FluxNode owner level

  { method: 'post', path: '/benchmark/signfluxnodetransaction', none: NONE.PROXY, handler: 'benchmarkService#signFluxTransactionPost' },
  { method: 'post', path: '/benchmark/signzelnodetransaction', none: NONE.PROXY, handler: 'benchmarkService#signFluxTransactionPost' }, // DEPRECATED

  // POST PROTECTED API - FluxTeam
  { method: 'post', path: '/flux/broadcastmessage', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageFromUserPost' },
  { method: 'post', path: '/flux/broadcastmessagetooutgoing', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageToOutgoingFromUserPost' },
  { method: 'post', path: '/flux/broadcastmessagetoincoming', none: NONE.PROCESS, handler: 'fluxCommunicationMessagesSender#broadcastMessageToIncomingFromUserPost' },
  { method: 'post', path: '/syncthing/system/error', none: NONE.PROXY, handler: 'syncthingService#postSystemError' },
  { method: 'post', path: '/syncthing/system/upgrade', none: NONE.PROXY, handler: 'syncthingService#postSystemUpgrade' },
  { method: 'post', path: '/syncthing/config', none: NONE.PROXY, handler: 'syncthingService#postConfig' },
  { method: 'post', path: '/syncthing/config/folders', none: NONE.PROXY, handler: 'syncthingService#postConfigFolders' },
  { method: 'post', path: '/syncthing/config/devices', none: NONE.PROXY, handler: 'syncthingService#postConfigDevices' },
  { method: 'post', path: '/syncthing/config/defaults/folder', none: NONE.PROXY, handler: 'syncthingService#postConfigDefaultsFolder' },
  { method: 'post', path: '/syncthing/config/defaults/device', none: NONE.PROXY, handler: 'syncthingService#postConfigDefaultsDevice' },
  { method: 'post', path: '/syncthing/config/options', none: NONE.PROXY, handler: 'syncthingService#postConfigOptions' },
  { method: 'post', path: '/syncthing/config/gui', none: NONE.PROXY, handler: 'syncthingService#postConfigGui' },
  { method: 'post', path: '/syncthing/config/ldap', none: NONE.PROXY, handler: 'syncthingService#postConfigLdap' },
  { method: 'post', path: '/syncthing/cluster/pending/devices', none: NONE.PROXY, handler: 'syncthingService#postClusterPendigDevices' },
  { method: 'post', path: '/syncthing/cluster/pending/folders', none: NONE.PROXY, handler: 'syncthingService#postClusterPendigFolders' },
  { method: 'post', path: '/syncthing/folder/versions', none: NONE.PROXY, handler: 'syncthingService#postFolderVersions' },
  { method: 'post', path: '/syncthing/db/override', none: NONE.PROXY, handler: 'syncthingService#postDbOverride' },
  { method: 'post', path: '/syncthing/db/prio', none: NONE.PROXY, handler: 'syncthingService#postDbPrio' },
  { method: 'post', path: '/syncthing/db/revert', none: NONE.PROXY, handler: 'syncthingService#postDbRevert' },
  { method: 'post', path: '/syncthing/db/scan', none: NONE.PROXY, handler: 'syncthingService#postDbScan' },

  // What is left of FluxShare: an operator collects the files a previous
  // release let them put on the node. Read only, and the node's operator only -
  // the token that served a file to whoever held the link is gone with the rest.
  { method: 'get', path: '/apps/fluxshare/getfolder/:folder?', none: NONE.OWN_ANSWER, handler: 'fluxshareService#fluxShareGetFolder' },
  { method: 'get', path: '/apps/fluxshare/getfile/:file?', none: NONE.OWN_ANSWER, handler: 'fluxshareService#fluxShareDownloadFile' },

  // Handing the file operation image to a node that cannot reach the registry.
  // Open to other Flux nodes rather than to an owner: it carries no app data,
  // and a node needing it has nobody to authenticate as.
  { method: 'get', path: '/apps/fileoperationimage/:imageid', none: NONE.PEER, handler: 'appSystem/volumeExecutor#serveImageToPeer' },
  // Volume Browser
  { method: 'get', path: '/apps/getfolderinfo/:appname?/:component?/:folder?', none: NONE.OWN_ANSWER, handler: 'appQuery/fileQueryService#getAppsFolder' },
  { method: 'get', path: '/apps/createfolder/:appname?/:component?/:folder?', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#createAppsFolder' },
  { method: 'get', path: '/apps/renameobject/:appname?/:component?/:oldpath?/:newname?', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#renameAppsObject' },
  { method: 'get', path: '/apps/removeobject/:appname?/:component?/:object?', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#removeAppsObject' },
  // Every endpoint that answers 202 points here: one status resource, one
  // status enum, one error shape, so a client polls the same way whatever it
  // started.
  { method: 'get', path: '/apps/operations/:jobId', none: NONE.PROCESS, handler: 'appManagement/operationsController#getOperation' },
  { method: 'delete', path: '/apps/operations/:jobId', none: NONE.PROCESS, handler: 'appManagement/operationsController#cancelOperation' },
  // POST, with the operands in a JSON body:
  //   { appname, component, source, destination, overwrite? }
  //
  // compressobject also takes `source` as a list of entries, and archives each
  // by its path from the deepest folder holding all of them.
  //
  // Not GET. These create, overwrite and destroy, and a GET may be replayed by
  // a proxy, a retry or a refresh - `overwrite: true` sitting in a URL is a
  // destructive operation waiting to be repeated. Thirty of the /apps/ GET
  // routes in this file are served through apicache, which makes a cached
  // destructive GET one config line away rather than impossible. A path also
  // puts every filename into the access log and the URL length limit.
  //
  // It matches the endpoints that already answer 202 here - imagepreflight,
  // playground and imagecache are all POST - rather than the older file API
  // whose GET shape these otherwise sit beside.
  //
  // `destination` is the full target path INCLUDING the new name, not the
  // parent directory, so copy and move share -T semantics and there is no
  // paste-into versus paste-as ambiguity.
  //
  // All four answer 202 with a jobId to poll at /apps/operations/:jobId. Move
  // included, even though its visible part is a rename: paste is one gesture in
  // a file browser, and cut-paste returning a result while copy-paste returns a
  // job would put two response shapes inside one user action.
  { method: 'post', path: '/apps/moveobject', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#moveAppsObject' },
  { method: 'post', path: '/apps/copyobject', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#copyAppsObject' },
  { method: 'post', path: '/apps/compressobject', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#compressAppsObject' },
  { method: 'post', path: '/apps/extractobject', needs: ['bootReconcileDecided'], handler: 'appSystem/fileSystemManager#extractAppsObject' },
  { method: 'get', path: '/apps/downloadfile/:appname?/:component?/:file?', none: NONE.OWN_ANSWER, handler: 'appSystem/fileSystemManager#downloadAppsFile' },
  { method: 'get', path: '/apps/downloadfolder/:appname?/:component?/:folder?', none: NONE.OWN_ANSWER, handler: 'appSystem/fileSystemManager#downloadAppsFolder' },
  { method: 'get', path: '/explorer/issynced', none: NONE.PROGRESS, cache: '30 seconds', handler: 'explorerService#isExplorerSynced' },

  // Cadence, read rather than streamed - see the rule at the top of
  // fluxEventBus.js. 404s in production, like the stream above.
  { method: 'get', path: '/flux/testcounters', none: NONE.PROCESS, handler: 'utils/fluxEventBus#countersHandler' },
  { method: 'post', path: '/flux/testcheckpoints', none: NONE.PROCESS, handler: 'utils/fluxEventBus#checkpointsHandler' },
];
