// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPermissionGuard
/// @notice Checks the arguments of a call that a PasskeyAccount session makes under a permission
///         naming this guard. The account calls it with STATICCALL right before the call runs, so
///         the guard sees the state the call will see and cannot change it.
interface IPermissionGuard {
    /// @notice Reverts unless `account` may call `target` with `data`; returns this function's
    ///         selector otherwise.
    function check(address account, address target, bytes calldata data) external view returns (bytes4);
}
