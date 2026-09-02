// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "solady/utils/Base64.sol";
import {LibString} from "solady/utils/LibString.sol";
import {WebAuthn} from "solady/utils/WebAuthn.sol";

/// @notice Builds WebAuthn assertions the way a browser authenticator does, signed with a P256 key.
library WebAuthnSigner {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    function sign(uint256 privateKey, bytes32 challengeDigest)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        string memory challenge = Base64.encode(abi.encode(challengeDigest), true, true);
        string memory prefix = '{"type":"webauthn.get","challenge":"';
        string memory clientDataJSON =
            string.concat(prefix, challenge, '","origin":"https://app.trendr.test","crossOrigin":false}');
        // rpIdHash | flags (user present + user verified) | sign count
        bytes memory authenticatorData = abi.encodePacked(sha256("app.trendr.test"), bytes1(0x05), bytes4(0));
        bytes32 messageHash = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = VM.signP256(privateKey, messageHash);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        auth = WebAuthn.WebAuthnAuth({
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON,
            challengeIndex: LibString.indexOf(clientDataJSON, '"challenge":"'),
            typeIndex: LibString.indexOf(clientDataJSON, '"type":"webauthn.get"'),
            r: r,
            s: s
        });
    }

    function publicKey(uint256 privateKey) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = VM.publicKeyP256(privateKey);
        return (bytes32(px), bytes32(py));
    }
}
