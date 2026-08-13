const shared = require('../shared.js');

module.exports = {
  ...shared,
  database: {
    "url": "198.18.0.2",
    "port": 27017,
    "local": {
        "database": "node02_zelfluxlocal",
        "collections": {
            "loggedUsers": "loggedusers",
            "activeLoginPhrases": "activeloginphrases",
            "activeSignatures": "activesignatures",
            "activePaymentRequests": "activepaymentrequests",
            "completedPayments": "completedpayments",
            "geolocation": "geolocation",
            "benchmark": "benchmark",
            "appTamperingEvents": "apptamperingevents",
            "nodeStartupTracker": "nodestartuptracker",
            "nodeIdentity": "nodeidentity",
            "policyDocuments": "policydocuments",
            "quorumGrants": "quorumgrants",
            "foundingCommittees": "foundingcommittees"
        }
    },
    "daemon": {
        "database": "node02_zelcashdata",
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
        "database": "node02_localzelapps",
        "collections": {
            "appsInformation": "zelappsinformation",
            "appsRuntimeState": "zelappsruntimestate",
            "pendingAppTeardowns": "zelappspendingteardowns",
            "cachedImages": "cachedimages",
            "playgroundSessions": "playgroundsessions"
        }
    },
    "appsglobal": {
        "database": "node02_globalzelapps",
        "collections": {
            "appsMessages": "zelappsmessages",
            "appsInformation": "zelappsinformation",
            "appsTemporaryMessages": "zelappstemporarymessages",
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
        "database": "node02_marketplace",
        "collections": {
            "templates": "marketplacetemplates"
        }
    },
    "chainparams": {
        "database": "node02_chainparams",
        "collections": {
            "chainMessages": "chainmessages",
            "priceMessages": "pricemessages",
            "rateMessages": "ratemessages",
            "priceModifierMessages": "pricemodifiermessages",
            "oracleKeyMessages": "oraclekeymessages",
            "marketplacePricingMessages": "marketplacepricingmessages",
            "policyGroupMessages": "policygroupmessages"
        }
    },
    "fluxshare": {
        "database": "node02_zelshare",
        "collections": {
            "shared": "shared"
        }
    }
},
};
