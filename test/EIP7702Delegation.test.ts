import { expect } from "chai";
import { ethers } from "hardhat";

describe("EIP7702Delegation", function () {
  it("sets and revokes delegation", async function () {
    const [delegator, delegatee] = await ethers.getSigners();

    const Delegation = await ethers.getContractFactory("EIP7702Delegation");
    const delegation = await Delegation.deploy(delegator.address);
    await delegation.waitForDeployment();

    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    await delegation.connect(delegator).setDelegation(delegatee.address, {
      active: true,
      expiresAt,
      maxGasPerTx: 500000,
      dailyGasLimit: 2000000,
      dailyGasUsed: 0,
      lastResetDay: 0,
      allowedMethods: [],
      allowedTokens: [],
    });

    const stored = await delegation.delegations(
      delegator.address,
      delegatee.address,
    );
    expect(stored.active).to.equal(true);
    expect(stored.expiresAt).to.equal(expiresAt);

    await delegation.connect(delegator).revokeDelegation(delegatee.address);

    const cleared = await delegation.delegations(
      delegator.address,
      delegatee.address,
    );
    expect(cleared.active).to.equal(false);
    expect(cleared.expiresAt).to.equal(0);
  });

  it("allows only paymaster for executeViaPaymaster", async function () {
    const [paymaster, other] = await ethers.getSigners();

    const Delegation = await ethers.getContractFactory("EIP7702Delegation");
    const delegation = await Delegation.deploy(paymaster.address);
    await delegation.waitForDeployment();

    await expect(
      delegation.connect(other).executeViaPaymaster(
        {
          to: other.address,
          value: 0,
          data: "0x",
          gasLimit: 21000,
          nonce: 0,
          deadline: Math.floor(Date.now() / 1000) + 3600,
        },
        other.address,
        "0x",
      ),
    ).to.be.revertedWithCustomError(delegation, "OnlyPaymaster");
  });
});
