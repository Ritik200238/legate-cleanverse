// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LegateEscrow} from "../../src/LegateEscrow.sol";

/// @notice Adversarial test double: an ERC20 whose transfer() attempts to re-enter
///         LegateEscrow.settle() on the same paymentId mid-transfer. Used ONLY to prove
///         (not assert) that ReentrancyGuard + checks-effects-interactions actually stop a
///         double-settlement — a passing test suite that never attempted an attack proves
///         nothing about reentrancy safety. The real A-Token does not behave this way; this exists purely
///         to stress-test LegateEscrow's own defenses.
contract MaliciousReentrantToken is ERC20 {
    LegateEscrow public target;
    bytes32 public attackPaymentId;
    bool public attacking;

    constructor() ERC20("Malicious", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setAttack(LegateEscrow target_, bytes32 paymentId_) external {
        target = target_;
        attackPaymentId = paymentId_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // Attempt reentry exactly once, only when transferring OUT of the escrow contract
        // (i.e., during a settle() payout), to simulate a hostile recipient/token trying to
        // double-spend the same escrowed payment.
        if (!attacking && address(target) != address(0) && from == address(target)) {
            attacking = true;
            target.settle(attackPaymentId); // expected to revert — state already flipped
            attacking = false;
        }
    }
}
