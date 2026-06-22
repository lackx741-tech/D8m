// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title PaymasterSweeper
 * @notice Backend contract that sponsors gas for EIP-7702 delegations
 */
contract PaymasterSweeper {
    address public owner;
    address public delegationImplementation;

    mapping(address => uint256) public sponsoredGas;
    uint256 public totalSponsored;

    event TransactionSponsored(
        address indexed user,
        address indexed target,
        uint256 gasUsed,
        uint256 refundAmount
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _delegationImplementation) {
        owner = msg.sender;
        delegationImplementation = _delegationImplementation;
    }

    function sponsorTransaction(
        address delegationContract,
        bytes calldata executionData
    ) external onlyOwner returns (bool) {
        uint256 gasStart = gasleft();

        (bool success, ) = delegationContract.call(executionData);

        uint256 gasUsed = gasStart - gasleft();
        sponsoredGas[tx.origin] += gasUsed;
        totalSponsored += gasUsed;

        emit TransactionSponsored(tx.origin, delegationContract, gasUsed, 0);

        return success;
    }

    function batchSponsor(
        address[] calldata delegationContracts,
        bytes[] calldata executionDatas
    ) external onlyOwner returns (bool[] memory results) {
        require(
            delegationContracts.length == executionDatas.length,
            "Length mismatch"
        );

        results = new bool[](delegationContracts.length);
        for (uint256 i = 0; i < delegationContracts.length; i++) {
            (bool success, ) = delegationContracts[i].call(executionDatas[i]);
            results[i] = success;
        }

        return results;
    }

    receive() external payable {}

    function withdraw() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }
}
