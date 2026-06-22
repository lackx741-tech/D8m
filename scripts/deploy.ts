import { ethers } from 'hardhat';
import { writeFileSync } from 'fs';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  const EIP7702Delegation = await ethers.getContractFactory('EIP7702Delegation');
  const delegation = await EIP7702Delegation.deploy(deployer.address);
  await delegation.waitForDeployment();
  console.log('EIP7702Delegation:', await delegation.getAddress());

  const PaymasterSweeper = await ethers.getContractFactory('PaymasterSweeper');
  const paymaster = await PaymasterSweeper.deploy(await delegation.getAddress());
  await paymaster.waitForDeployment();
  console.log('PaymasterSweeper:', await paymaster.getAddress());

  const addresses = {
    delegation: await delegation.getAddress(),
    paymaster: await paymaster.getAddress(),
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
  };

  writeFileSync('deployed.json', JSON.stringify(addresses, null, 2));
}

main().catch(console.error);
