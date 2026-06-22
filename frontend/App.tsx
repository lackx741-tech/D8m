import React from 'react';
import { EIP7702Provider } from './EIP7702Provider';
import { useDelegation } from './useEIP7702';

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
      expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      maxGasPerTx: '500000',
      dailyGasLimit: '10000000',
      allowedMethods: ['0xa9059cbb'],
      allowedTokens: ['0x...token1...', '0x...token2...'],
    });
  };

  const handleSweep = async () => {
    const txHash = await sweepAssets(['0x...token1...', '0x...token2...'], '0x...recipient...');
    console.log('Sweep tx:', txHash);
  };

  const handleSendToken = async () => {
    const txHash = await sendGaslessTokenTransfer('0x...token...', '0x...recipient...', '100');
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

      {!isDelegated && <button onClick={handleSetDelegation}>Set Delegation</button>}

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
