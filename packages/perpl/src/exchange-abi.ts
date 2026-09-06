// The Perpl Exchange ABI subset Trendr uses, from PerplFoundation/dex-sdk (MIT),
// crates/sdk/abi/dex/Exchange.json at revision rc_v1.1.7-203-g0e5902dd: the account and order
// functions, and every account, collateral, order, fill and position event (the deployed Exchange
// emits V2 order, fill and opening events and V1 decrease and close events). Do not edit by hand.

export const exchangeAbi = [
  {
    "type": "function",
    "name": "allowOrderForwarding",
    "inputs": [
      {
        "name": "allow",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createAccount",
    "inputs": [
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "depositCollateral",
    "inputs": [
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "execOrder",
    "inputs": [
      {
        "name": "orderDesc",
        "type": "tuple",
        "internalType": "struct OrderDesc",
        "components": [
          {
            "name": "orderDescId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderType",
            "type": "uint8",
            "internalType": "enum OrderDescEnum"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "postOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fillOrKill",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "immediateOrCancel",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "maxMatches",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "leverageHdths",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastExecutionBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxNegPnlCollatBPS",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "signature",
        "type": "tuple",
        "internalType": "struct OrderSignature",
        "components": [
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "execOrderV2",
    "inputs": [
      {
        "name": "orderDesc",
        "type": "tuple",
        "internalType": "struct OrderDesc",
        "components": [
          {
            "name": "orderDescId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderType",
            "type": "uint8",
            "internalType": "enum OrderDescEnum"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "postOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fillOrKill",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "immediateOrCancel",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "maxMatches",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "leverageHdths",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastExecutionBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxNegPnlCollatBPS",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "extension",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "signature",
        "type": "tuple",
        "internalType": "struct OrderSignature",
        "components": [
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "execOrders",
    "inputs": [
      {
        "name": "orderDescs",
        "type": "tuple[]",
        "internalType": "struct OrderDesc[]",
        "components": [
          {
            "name": "orderDescId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderType",
            "type": "uint8",
            "internalType": "enum OrderDescEnum"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "postOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fillOrKill",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "immediateOrCancel",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "maxMatches",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "leverageHdths",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastExecutionBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxNegPnlCollatBPS",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "revertOnFail",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "signatures",
        "type": "tuple[]",
        "internalType": "struct OrderSignature[]",
        "components": [
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "execOrdersV2",
    "inputs": [
      {
        "name": "orderDescs",
        "type": "tuple[]",
        "internalType": "struct OrderDesc[]",
        "components": [
          {
            "name": "orderDescId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderType",
            "type": "uint8",
            "internalType": "enum OrderDescEnum"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "expiryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "postOnly",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "fillOrKill",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "immediateOrCancel",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "maxMatches",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "leverageHdths",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastExecutionBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxNegPnlCollatBPS",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "revertOnFail",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "extensions",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "signatures",
        "type": "tuple[]",
        "internalType": "struct OrderSignature[]",
        "components": [
          {
            "name": "perpId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "orderId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getAccountByAddr",
    "inputs": [
      {
        "name": "accountAddress",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "accountInfo",
        "type": "tuple",
        "internalType": "struct AccountInfo",
        "components": [
          {
            "name": "accountId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "balanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lockedBalanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "frozen",
            "type": "uint8",
            "internalType": "enum FreezeStatusEnum"
          },
          {
            "name": "accountAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "positions",
            "type": "tuple",
            "internalType": "struct PositionBitMap",
            "components": [
              {
                "name": "bank1",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank2",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank3",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank4",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getAccountById",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "accountInfo",
        "type": "tuple",
        "internalType": "struct AccountInfo",
        "components": [
          {
            "name": "accountId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "balanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lockedBalanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "frozen",
            "type": "uint8",
            "internalType": "enum FreezeStatusEnum"
          },
          {
            "name": "accountAddr",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "positions",
            "type": "tuple",
            "internalType": "struct PositionBitMap",
            "components": [
              {
                "name": "bank1",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank2",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank3",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "bank4",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getContractVersion",
    "inputs": [],
    "outputs": [
      {
        "name": "major",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minor",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "patch",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPerpetualInfo",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "perpetualInfo",
        "type": "tuple",
        "internalType": "struct PerpetualInfo",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "priceDecimals",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotDecimals",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "linkFeedId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "priceTolPer100K",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "marginTol",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "marginTolDecimals",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "refPriceMaxAgeSec",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "positionBalanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "insuranceBalanceCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "markPNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "markTimestamp",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastPNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lastTimestamp",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "oraclePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "oracleTimestampSec",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "longOpenInterestLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "shortOpenInterestLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "fundingStartBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "fundingRatePct100k",
            "type": "int16",
            "internalType": "int16"
          },
          {
            "name": "absFundingClampPctPer100K",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum PerpStatusEnum"
          },
          {
            "name": "basePricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxBidPriceONS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minBidPriceONS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxAskPriceONS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minAskPriceONS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "numOrders",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "ignOracle",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPosition",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "positionInfo",
        "type": "tuple",
        "internalType": "struct PositionInfo",
        "components": [
          {
            "name": "accountId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "nextNodeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "prevNodeId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "positionType",
            "type": "uint8",
            "internalType": "enum PositionEnum"
          },
          {
            "name": "depositCNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pricePNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "lotLNS",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "entryBlock",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pnlCNS",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "deltaPnlCNS",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "premiumPnlCNS",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "markPriceValid",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "increasePositionCollateral",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdrawCollateral",
    "inputs": [
      {
        "name": "amountCNS",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AccountCreated",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AccountFeeTierSet",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "tier",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AccountFreeze",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "status",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum FreezeStatusEnum"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AccountFrozen",
    "inputs": [
      {
        "name": "status",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum FreezeStatusEnum"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AccountLiquidationCredit",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralDecreaseDeclined",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralDecreaseRequestCancelled",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralDecreaseRequestExpired",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "expiryTS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "blockTS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralDecreaseRequested",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "expiryTS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "clampToMaximum",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "entryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralDeposit",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CollateralWithdrawal",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MakerOrderFilled",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MakerOrderFilledV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "builderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "builderFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MakerOrderSettlementFailed",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum OrderEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "maxNegPnlCollatBPS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "recyclerAccountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "recyclerAmountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "recyclerBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderBatchCompleted",
    "inputs": [
      {
        "name": "gasLeft",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderCancelled",
    "inputs": [
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderCancelledByAdmin",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderCancelledByLiquidator",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderChanged",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "expiryBlock",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderDescIdTooLow",
    "inputs": [
      {
        "name": "lastOrderDescId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderDoesNotExist",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderExtensionRejected",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderForwardingNotAllowed",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderForwardingUpdated",
    "inputs": [
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderPlaced",
    "inputs": [
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lockedBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderPostFailed",
    "inputs": [
      {
        "name": "reason",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderRequest",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderDescId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum OrderDescEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "expiryBlock",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "postOnly",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "fillOrKill",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "immediateOrCancel",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "maxMatches",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lastExecutionBlock",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "maxNegPnlCollatBPS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "gasLeft",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderRequestV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderDescId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum OrderDescEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "expiryBlock",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "postOnly",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "fillOrKill",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "immediateOrCancel",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "maxMatches",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lastExecutionBlock",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "maxNegPnlCollatBPS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "gasLeft",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "extension",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderSettlementImpliesInsolvent",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "orderType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum OrderEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "perpPositionBalCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "perpInsuranceBalCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "addedPosCollatReqCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "requestedAmountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OrderSizeExceedsAvailableSize",
    "inputs": [
      {
        "name": "orderLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "availableLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionAdministratorUpdated",
    "inputs": [
      {
        "name": "positionAdministrator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "added",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionClosed",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionCollateralDecreased",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "impactAdjPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startEntryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endEntryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "effBmfHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "decreaseCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionDecreased",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionDeleveraged",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "forceClose",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "entryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deleveragePricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionDeleveragedV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "forceClose",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "entryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deleveragePricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceResiduePNSQ16",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionDoesNotExist",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionIncreased",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlCollateralizedCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "premiumPnlSettledCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "maxNegPnlCollatBPS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "insFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionIncreasedV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlCollateralizedCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "premiumPnlSettledCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "maxNegPnlCollatBPS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "insFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceResiduePNSQ16",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionInverted",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlCollateralizedCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "insFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionLiquidated",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "posAccountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "liqPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "liqLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "posLotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "deltaPnlCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "fundingCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "posAmountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "posDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accAmountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "accBalanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "onOrderBook",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionLiquidationCredit",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "startDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "endDepositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionOpened",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlCollateralizedCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "insFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionOpenedV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "leverageHdths",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlCollateralizedCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "insFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceResiduePNSQ16",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionUnwound",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionFmvCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "paymentCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionUnwoundV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionFmvCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "paymentCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceResiduePNSQ16",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionUnwoundWithoutPayment",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionFmvCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "amountOwedCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PositionUnwoundWithoutPaymentV2",
    "inputs": [
      {
        "name": "perpId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "accountId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "markPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionType",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum PositionEnum"
      },
      {
        "name": "pricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "depositCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "positionFmvCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "amountOwedCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "priceResiduePNSQ16",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TakerOrderFilled",
    "inputs": [
      {
        "name": "entryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "collatPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TakerOrderFilledV2",
    "inputs": [
      {
        "name": "entryPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "collatPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pnlPricePNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "lotLNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "feeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amountCNS",
        "type": "int256",
        "indexed": false,
        "internalType": "int256"
      },
      {
        "name": "balanceCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "builderId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "builderFeeCNS",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  }
] as const;
