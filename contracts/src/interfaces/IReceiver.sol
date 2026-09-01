// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver
/// @notice Chainlink CRE report receiver. The KeystoneForwarder (or the MockKeystoneForwarder in
///         simulation) calls `onReport` with the workflow metadata and the ABI-encoded report.
/// @dev Matches smartcontractkit/chainlink-evm contracts/cre/src/v1/interfaces/IReceiver.sol.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
