import { expect } from "chai";
import { ethers } from "hardhat";

const ONE_HOUR_IN_SECONDS = 3600;

describe("PaymasterSweeper", function () {
  it("forwards executeViaPaymaster calldata and updates sponsored gas", async function () {
    const [owner, delegator] = await ethers.getSigners();

    const Delegation = await ethers.getContractFactory("EIP7702Delegation");
    const delegation = await Delegation.deploy();
    await delegation.waitForDeployment();

    const Paymaster = await ethers.getContractFactory("PaymasterSweeper");
    const paymaster = await Paymaster.deploy(await delegation.getAddress());
    await paymaster.waitForDeployment();

    await delegation.connect(owner).setPaymaster(await paymaster.getAddress());

    const Target = await ethers.getContractFactory("MockTarget");
    const target = await Target.deploy();
    await target.waitForDeployment();

    const setValueData = target.interface.encodeFunctionData("setValue", [42n]);
    const chain = await ethers.provider.getNetwork();

    const request = {
      to: await target.getAddress(),
      value: 0n,
      data: setValueData,
      gasLimit: 200000n,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + ONE_HOUR_IN_SECONDS),
    };

    const domain = {
      name: "EIP7702Delegation",
      version: "1",
      chainId: chain.chainId,
      verifyingContract: await delegation.getAddress(),
    };

    const types = {
      ExecutionRequest: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "gasLimit", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    const signature = await delegator.signTypedData(domain, types, request);
    const executionData = delegation.interface.encodeFunctionData(
      "executeViaPaymaster",
      [request, delegator.address, signature],
    );

    await expect(
      paymaster
        .connect(owner)
        .sponsorTransaction(await delegation.getAddress(), executionData),
    ).to.emit(paymaster, "TransactionSponsored");

    expect(await target.value()).to.equal(42n);
    expect(await delegation.nonces(delegator.address)).to.equal(1n);
    expect(await paymaster.totalSponsored()).to.be.gt(0n);
  });

  it("restricts sponsorship to owner", async function () {
    const [owner, other] = await ethers.getSigners();

    const Delegation = await ethers.getContractFactory("EIP7702Delegation");
    const delegation = await Delegation.deploy();
    await delegation.waitForDeployment();

    const Paymaster = await ethers.getContractFactory("PaymasterSweeper");
    const paymaster = await Paymaster.deploy(await delegation.getAddress());
    await paymaster.waitForDeployment();

    await expect(
      paymaster
        .connect(other)
        .sponsorTransaction(await delegation.getAddress(), "0x"),
    ).to.be.revertedWith("Not owner");
  });
});
