import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import cors from 'cors';
import dotenv from 'dotenv';
import { Redis } from 'ioredis';

dotenv.config();

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

const DELEGATION_ABI = [
  'function executeViaPaymaster(tuple(address to, uint256 value, bytes data, uint256 gasLimit, uint256 nonce, uint256 deadline) request, address delegator, bytes signature) external returns (bool)',
  'function nonces(address) view returns (uint256)',
  'function delegations(address delegator, address delegatee) view returns (bool active, uint256 expiresAt, uint256 maxGasPerTx, uint256 dailyGasLimit, uint256 dailyGasUsed, uint256 lastResetDay)',
  'function sweepERC20(address[] tokens, address recipient) external',
  'function paymaster() view returns (address)',
];

class PaymasterService {
  private redis: Redis;
  private wallets: Map<number, ethers.Wallet> = new Map();
  private providers: Map<number, ethers.JsonRpcProvider> = new Map();

  constructor() {
    this.redis = new Redis(CONFIG.REDIS_URL);

    for (const [chainId, rpcUrl] of Object.entries(CONFIG.RPC_URLS)) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);

      this.providers.set(Number(chainId), provider);
      this.wallets.set(Number(chainId), wallet);
    }
  }

  async sponsorTransaction(request: SponsorshipRequest): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    gasUsed?: string;
  }> {
    try {
      const { delegator, executionRequest, signature, chainId } = request;
      const wallet = this.wallets.get(chainId);
      const provider = this.providers.get(chainId);
      if (!wallet || !provider) {
        return { success: false, error: 'Unsupported chain' };
      }

      const canSponsor = await this.checkRateLimits(delegator, chainId);
      if (!canSponsor) {
        return { success: false, error: 'Rate limit exceeded' };
      }

      const isValid = await this.validateExecutionRequest(delegator, executionRequest, chainId);
      if (!isValid.valid) {
        return { success: false, error: isValid.error };
      }

      const delegationContract = new ethers.Contract(
        CONFIG.DELEGATION_CONTRACTS[chainId as keyof typeof CONFIG.DELEGATION_CONTRACTS],
        DELEGATION_ABI,
        wallet
      );

      const currentNonce = await delegationContract.nonces(delegator);
      if (currentNonce !== BigInt(executionRequest.nonce)) {
        return { success: false, error: 'Invalid nonce' };
      }

      if (Date.now() / 1000 > executionRequest.deadline) {
        return { success: false, error: 'Deadline passed' };
      }

      const domain = {
        name: 'EIP7702Delegation',
        version: '1',
        chainId,
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

      const recoveredAddress = ethers.verifyTypedData(domain, types, executionRequest, signature);
      if (recoveredAddress.toLowerCase() !== delegator.toLowerCase()) {
        return { success: false, error: 'Invalid signature' };
      }

      const tx = await delegationContract.executeViaPaymaster(executionRequest, delegator, signature, {
        gasLimit: BigInt(executionRequest.gasLimit) + 50000n,
      });

      const receipt = await tx.wait();
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
        const delegationContract = new ethers.Contract(delegators[i], DELEGATION_ABI, wallet);
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

  private async checkRateLimits(delegator: string, chainId: number): Promise<boolean> {
    const key = `sponsor:${chainId}:${delegator}:${this.getDayKey()}`;
    const dailyGas = await this.redis.get(key);
    const maxDailyGas = 1000000;
    return !dailyGas || parseInt(dailyGas) < maxDailyGas;
  }

  private async updateRateLimits(delegator: string, chainId: number, gasUsed: bigint): Promise<void> {
    const key = `sponsor:${chainId}:${delegator}:${this.getDayKey()}`;
    const pipeline = this.redis.pipeline();
    pipeline.incrby(key, Number(gasUsed));
    pipeline.expire(key, 86400);
    await pipeline.exec();
  }

  private async validateExecutionRequest(
    delegator: string,
    request: ExecutionRequest,
    chainId: number
  ): Promise<{ valid: boolean; error?: string }> {
    void delegator;
    void chainId;

    const maxGas = 500000;
    if (BigInt(request.gasLimit) > maxGas) {
      return { valid: false, error: 'Gas limit too high' };
    }

    if (BigInt(request.value) > ethers.parseEther('1')) {
      return { valid: false, error: 'Value too high' };
    }

    return { valid: true };
  }

  private getDayKey(): string {
    return Math.floor(Date.now() / 86400000).toString();
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const paymasterService = new PaymasterService();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/sponsor', async (req: Request, res: Response) => {
  const result = await paymasterService.sponsorTransaction(req.body);
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/sweep', async (req: Request, res: Response) => {
  const { delegators, tokens, recipient, chainId } = req.body;
  const result = await paymasterService.batchSweep(delegators, tokens, recipient, chainId);
  res.status(result.success ? 200 : 400).json(result);
});

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
