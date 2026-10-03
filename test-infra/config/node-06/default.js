const shared = require('../shared.js');

module.exports = {
  ...shared,
  database: {
    "url": "31.200.0.2",
    "port": 27017,
    "local": {
        "database": "node06_zelfluxlocal",
        "collections": {
            "loggedUsers": "loggedusers",
            "activeLoginPhrases": "activeloginphrases",
            "activeSignatures": "activesignatures",
            "loginSignatures": "loginsignatures",
            "geolocation": "geolocation",
            "benchmark": "benchmark",
            "appTamperingEvents": "apptamperingevents",
            "nodeStartupTracker": "nodestartuptracker",
            "nodeIdentity": "nodeidentity",
            "policyDocuments": "policydocuments",
            "ipRanges": "ipranges",
            "nodeLocations": "nodelocations",
            "ownAddress": "ownaddress",
            "quorumGrants": "quorumgrants",
            "fileOperations": "fileoperations",
            "foundingCommittees": "foundingcommittees"
        }
    },
    "daemon": {
        "database": "node06_zelcashdata",
        "collections": {
            "scannedHeight": "scannedheight",
            "utxoIndex": "utxoindex",
            "addressTransactionIndex": "addresstransactionindex",
            "fluxTransactions": "zelnodetransactions",
            "appsHashes": "zelappshashes",
            "coinbaseFusionIndex": "coinbasefusionindex"
        }
    },
    "appslocal": {
        "database": "node06_localzelapps",
        "collections": {
            "appsInformation": "zelappsinformation",
            "appsRuntimeState": "zelappsruntimestate",
            "appsPlacements": "zelappsplacements",
            "pendingAppTeardowns": "zelappspendingteardowns",
            "cachedImages": "cachedimages",
            "playgroundSessions": "playgroundsessions"
        }
    },
    "appsglobal": {
        "database": "node06_globalzelapps",
        "collections": {
            "appsMessages": "zelappsmessages",
            "appDecisions": "appdecisions",
            "appsInformation": "zelappsinformation",
            "appsTemporaryMessages": "zelappstemporarymessages",
            "appsUnpayableMessages": "appsunpayablemessages",
            "appsInstallingLocations": "appsinstallinglocations",
            "limitCounterRecords": "limitcounterrecords",
            "appsInstallingErrorsLocations": "appsInstallingErrorsLocations",
            "appStateEvents": "appstateevents",
            "appsInstallingBroadcasts": "fluxappinstallingbroadcasts",
            "appsInstallingErrorsBroadcasts": "fluxappinstallingerrorsbroadcasts",
            "appContentManifests": "appcontentmanifests",
            "appsIngressAttestations": "appingressattestations",
            "appsIngressAttestationDigests": "appingressattestationdigests"
        }
    },
    "marketplace": {
        "database": "node06_marketplace",
        "collections": {
            "templates": "marketplacetemplates"
        }
    },
    "chainparams": {
        "database": "node06_chainparams",
        "collections": {
            "chainMessages": "chainmessages",
            "priceMessages": "pricemessages",
            "rateMessages": "ratemessages",
            "priceModifierMessages": "pricemodifiermessages",
            "oracleKeyMessages": "oraclekeymessages",
            "policyGroupMessages": "policygroupmessages"
        }
    }
},
};
