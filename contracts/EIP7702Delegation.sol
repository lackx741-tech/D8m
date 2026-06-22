// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title EIP7702Delegation
 * @notice Delegation contract for EIP-7702 enabling persistent gasless transactions
 * @dev This contract is called via DELEGATECALL from an EOA with EIP-7702 auth
 */
contract EIP7702Delegation is EIP712 {
    using ECDSA for bytes32;

    mapping(address => mapping(address => DelegationPermissions))
        public delegations;
    mapping(address => uint256) public nonces;
    address public owner;
    address public paymaster;

    struct DelegationPermissions {
        bool active;
        uint256 expiresAt;
        uint256 maxGasPerTx;
        uint256 dailyGasLimit;
        uint256 dailyGasUsed;
        uint256 lastResetDay;
        bytes4[] allowedMethods;
        address[] allowedTokens;
    }

    struct ExecutionRequest {
        address to;
        uint256 value;
        bytes data;
        uint256 gasLimit;
        uint256 nonce;
        uint256 deadline;
    }

    event DelegationSet(
        address indexed delegator,
        address indexed delegatee,
        uint256 expiresAt
    );
    event DelegationRevoked(
        address indexed delegator,
        address indexed delegatee
    );
    event ExecutedViaPaymaster(
        address indexed delegator,
        address indexed paymaster,
        bytes32 indexed txHash,
        bool success
    );
    event AssetsSwept(
        address indexed recipient,
        address[] tokens,
        uint256[] amounts
    );

    error DelegationExpired();
    error InvalidSignature();
    error GasLimitExceeded();
    error DailyLimitExceeded();
    error MethodNotAllowed();
    error TokenNotAllowed();
    error InvalidNonce();
    error DeadlinePassed();
    error OnlyPaymaster();
    error OnlySelf();
    error OnlyOwner();

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    constructor() EIP712("EIP7702Delegation", "1") {
        owner = msg.sender;
        paymaster = msg.sender;
    }

    function setPaymaster(address newPaymaster) external {
        if (msg.sender != owner) revert OnlyOwner();
        paymaster = newPaymaster;
    }

    function setDelegation(
        address delegatee,
        DelegationPermissions calldata permissions
    ) external {
        delegations[msg.sender][delegatee] = permissions;
        emit DelegationSet(msg.sender, delegatee, permissions.expiresAt);
    }

    function revokeDelegation(address delegatee) external {
        delete delegations[msg.sender][delegatee];
        emit DelegationRevoked(msg.sender, delegatee);
    }

    function executeViaPaymaster(
        ExecutionRequest calldata request,
        address delegator,
        bytes calldata signature
    ) external returns (bool success) {
        if (msg.sender != paymaster) revert OnlyPaymaster();
        success = _executeWithValidation(request, delegator, signature);
        emit ExecutedViaPaymaster(
            delegator,
            paymaster,
            keccak256(abi.encode(request)),
            success
        );
    }

    function executeAsDelegatee(
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory) {
        address delegator = _getDelegator();
        DelegationPermissions storage perms = delegations[delegator][
            msg.sender
        ];

        _validatePermissions(perms, to, data, gasleft());

        (bool success, bytes memory result) = to.call{value: value}(data);
        require(success, string(result));

        return result;
    }

    function sweepERC20(
        address[] calldata tokens,
        address recipient
    ) external onlySelf returns (uint256[] memory amounts) {
        amounts = new uint256[](tokens.length);
        address delegator = _getDelegator();

        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 balance = token.balanceOf(delegator);

            if (balance > 0) {
                (bool success, ) = tokens[i].call(
                    abi.encodeWithSelector(
                        IERC20.transfer.selector,
                        recipient,
                        balance
                    )
                );

                if (success) {
                    amounts[i] = balance;
                }
            }
        }

        emit AssetsSwept(recipient, tokens, amounts);
    }

    function sweepETH(address recipient) external onlySelf {
        uint256 balance = address(this).balance;
        (bool success, ) = recipient.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    function _executeWithValidation(
        ExecutionRequest calldata request,
        address delegator,
        bytes calldata signature
    ) internal returns (bool) {
        if (block.timestamp > request.deadline) revert DeadlinePassed();
        if (request.nonce != nonces[delegator]) revert InvalidNonce();
        nonces[delegator]++;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ExecutionRequest(address to,uint256 value,bytes data,uint256 gasLimit,uint256 nonce,uint256 deadline)"
                ),
                request.to,
                request.value,
                keccak256(request.data),
                request.gasLimit,
                request.nonce,
                request.deadline
            )
        );

        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);

        if (signer != delegator) revert InvalidSignature();

        (bool success, ) = request.to.call{
            value: request.value,
            gas: request.gasLimit
        }(request.data);
        return success;
    }

    function _validatePermissions(
        DelegationPermissions storage perms,
        address,
        bytes calldata data,
        uint256 gas
    ) internal view {
        if (!perms.active) revert DelegationExpired();
        if (block.timestamp > perms.expiresAt) revert DelegationExpired();
        if (gas > perms.maxGasPerTx) revert GasLimitExceeded();

        if (perms.allowedMethods.length > 0) {
            bytes4 selector = bytes4(data[:4]);
            bool allowed = false;
            for (uint256 i = 0; i < perms.allowedMethods.length; i++) {
                if (perms.allowedMethods[i] == selector) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) revert MethodNotAllowed();
        }
    }

    function _getDelegator() internal view returns (address) {
        return address(this);
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
