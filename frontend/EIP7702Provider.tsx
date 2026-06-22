import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { EthereumClient, w3mConnectors, w3mProvider } from '@web3modal/ethereum';
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

interface DelegationPermissions {
  expiresAt: number;
  maxGasPerTx: string;
  dailyGasLimit: string;
  allowedMethods: string[];
  allowedTokens: string[];
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

const EIP_7702_AUTH_MAGIC = '0xef0100';

const CONFIG: Record<number, EIP7702Config> = {
  1: { delegationContract: '0x...', paymasterUrl: 'https://paymaster.example.com', chainId: 1 },
  137: { delegationContract: '0x...', paymasterUrl: 'https://paymaster.example.com', chainId: 137 },
  8453: { delegationContract: '0x...', paymasterUrl: 'https://paymaster.example.com', chainId: 8453 },
};

const chains = [mainnet, polygon, base, arbitrum];
const projectId = 'YOUR_WALLETCONNECT_PROJECT_ID';

const { publicClient } = configureChains(chains, [w3mProvider({ projectId }), publicProvider()]);

const wagmiConfig = createConfig({
  autoConnect: true,
  connectors: w3mConnectors({ projectId, chains }),
  publicClient,
});

const ethereumClient = new EthereumClient(wagmiConfig, chains);
const DelegationContext = createContext<DelegationContextType | undefined>(undefined);

export const EIP7702Provider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <WagmiConfig config={wagmiConfig}>
      <DelegationProviderInner>
        <Web3Modal projectId={projectId} ethereumClient={ethereumClient} />
        {children}
      </DelegationProviderInner>
    </WagmiConfig>
  );
};

const DelegationProviderInner: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { address, isConnected } = useAccount();
  const { chain } = useNetwork();
  const { disconnect } = useDisconnect();
  const { switchNetwork } = useSwitchNetwork();
  const { signTypedDataAsync } = useSignTypedData();

  const [delegationNonce, setDelegationNonce] = useState(0);
  const [isDelegated, setIsDelegated] = useState(false);

  useEffect(() => {
    if (address && chain) {
      void checkDelegationStatus();
    }
  }, [address, chain]);

  const checkDelegationStatus = async () => {
    if (!address || !chain) return;

    const provider = new ethers.JsonRpcProvider(chain.rpcUrls.default.http[0]);
    const code = await provider.getCode(address);
    setIsDelegated(code.startsWith(EIP_7702_AUTH_MAGIC));

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
    void switchNetwork;
  }, [switchNetwork]);

  const setDelegation = async (delegatee: string, permissions: DelegationPermissions) => {
    if (!address || !chain) throw new Error('Not connected');

    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');

    const authData = {
      chainId: chain.id,
      address: config.delegationContract,
      nonce: await new ethers.JsonRpcProvider(chain.rpcUrls.default.http[0]).getTransactionCount(address),
    };

    console.log('Setting delegation:', authData, delegatee, permissions);
    setIsDelegated(true);
  };

  const executeViaPaymaster = async (request: ExecutionRequest): Promise<string> => {
    if (!address || !chain) throw new Error('Not connected');

    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');

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

    setDelegationNonce((prev) => prev + 1);
    return result.txHash;
  };

  const sweepAssets = async (tokens: string[], recipient: string): Promise<string> => {
    if (!address || !chain) throw new Error('Not connected');

    const config = CONFIG[chain.id];
    if (!config) throw new Error('Unsupported chain');

    const data = new ethers.Interface([
      'function sweepERC20(address[] tokens, address recipient)',
    ]).encodeFunctionData('sweepERC20', [tokens, recipient]);

    const request: ExecutionRequest = {
      to: config.delegationContract,
      value: '0',
      data,
      gasLimit: '300000',
      nonce: delegationNonce,
      deadline: Math.floor(Date.now() / 1000) + 3600,
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

  return <DelegationContext.Provider value={value}>{children}</DelegationContext.Provider>;
};

export const useEIP7702 = () => {
  const context = useContext(DelegationContext);
  if (!context) {
    throw new Error('useEIP7702 must be used within EIP7702Provider');
  }
  return context;
};
