import { useEIP7702 } from './EIP7702Provider';
import { ethers } from 'ethers';

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
