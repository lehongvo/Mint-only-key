import { ethers } from "ethers";
import { EZDRM_NFT_CONTRACT_ABI } from "./abi";
import { MetadataInfo } from "./minNft";
import { EventEmitter } from "events";
import axios from "axios";
import "dotenv/config";

interface MintRequest {
  metadataInfo: MetadataInfo;
  mintToAddress: string;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  gasPrice?: bigint; // Optional gas price for retries
}

interface PendingTransaction {
  request: MintRequest;
  retries: number;
  gasPrice: bigint;
}

class OptimizedMintProcessor extends EventEmitter {
  private queue: MintRequest[] = [];
  private processing: boolean = false;
  private currentNonce: number = 0;
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private batchSize: number;
  private timeWindow: number;
  private maxRetries: number;
  private pendingTransactions: Map<number, PendingTransaction> = new Map();
  private lastGasPrice: bigint = BigInt(0);

  constructor(
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet,
    contract: ethers.Contract,
    options = {
      batchSize: 100, // Increased to 100 as per your requirement
      timeWindow: 2000, // Reduced to 2s for faster processing
      maxRetries: 3,
    }
  ) {
    super();
    this.provider = provider;
    this.wallet = wallet;
    this.contract = contract;
    this.batchSize = options.batchSize;
    this.timeWindow = options.timeWindow;
    this.maxRetries = options.maxRetries;
  }

  async initialize() {
    try {
      // Check if wallet has minting permission
      console.log("Checking if wallet has minting permission...");
      const walletAddress = await this.wallet.getAddress();
      console.log("Wallet address:", walletAddress);

      // Try to get owner of contract
      try {
        const owner = await this.contract.owner();
        console.log("Contract owner:", owner);
        if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
          throw new Error("Wallet is not the contract owner");
        }
      } catch (error) {
        console.error("Error checking contract owner:", error);
        throw error;
      }

      this.currentNonce = await this.provider.getTransactionCount(
        walletAddress
      );
      console.log(`Initialized with nonce: ${this.currentNonce}`);
      this.startErrorMonitoring();
    } catch (error) {
      console.error("Failed to initialize:", error);
      throw error;
    }
  }

  private startErrorMonitoring() {
    this.provider.on("block", async (blockNumber) => {
      console.log(
        `New block: ${blockNumber}, checking pending transactions...`
      );
      try {
        for (const [nonce, pendingTx] of this.pendingTransactions.entries()) {
          try {
            const txResponse = await this.provider.getTransaction(
              nonce.toString()
            );

            if (!txResponse && pendingTx.retries < this.maxRetries) {
              console.log(
                `Transaction with nonce ${nonce} was dropped, retrying...`
              );
              const newGasPrice =
                (pendingTx.gasPrice * BigInt(120)) / BigInt(100); // Increase by 20%
              this.pendingTransactions.delete(nonce);

              this.queue.unshift({
                ...pendingTx.request,
                gasPrice: newGasPrice,
              });

              if (!this.processing) {
                this.processBatch().catch((error) => {
                  console.error("Error processing batch:", error);
                  throw error;
                });
              }
            }
          } catch (error) {
            console.error(
              `Error checking transaction with nonce ${nonce}:`,
              error
            );
          }
        }
      } catch (error) {
        console.error("Error in error monitoring:", error);
      }
    });
  }

  async addToQueue(
    metadataInfo: MetadataInfo,
    mintToAddress: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        metadataInfo,
        mintToAddress,
        resolve,
        reject,
      });

      if (!this.processing) {
        this.processBatch().catch((error) => {
          console.error("Error processing batch:", error);
          reject(error);
        });
      }
    });
  }

  private async uploadMetadataInBatch(requests: MintRequest[]) {
    return Promise.all(
      requests.map(async (request) => {
        try {
          const form = new FormData();
          const metadataBlob = new Blob(
            [JSON.stringify(request.metadataInfo)],
            {
              type: "application/json",
            }
          );
          form.append("file", metadataBlob, "metadata.json");

          const pinataOptions = JSON.stringify({
            cidVersion: 1,
            customPinPolicy: {
              regions: [
                {
                  id: "FRA1",
                  desiredReplicationCount: 1,
                },
                {
                  id: "NYC1",
                  desiredReplicationCount: 1,
                },
              ],
            },
          });
          form.append("pinataOptions", pinataOptions);

          console.log("Uploading metadata to IPFS...");
          const response = await axios.post(process.env.PINATA_URL!, form, {
            maxBodyLength: Infinity,
            headers: {
              "Content-Type": `multipart/form-data`,
              Authorization: `Bearer ${process.env.PINATA_JWT}`,
              pinata_api_key: process.env.PINATA_API_KEY,
              pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY,
            },
          });

          if (!response.data || !response.data.IpfsHash) {
            throw new Error("Failed to get IPFS hash from Pinata");
          }

          console.log(
            "Metadata uploaded successfully:",
            response.data.IpfsHash
          );
          return {
            request,
            ipfsUrl: `${process.env.PINATA_CLOUD_URL}${response.data.IpfsHash}`,
          };
        } catch (error) {
          console.error("Error uploading to IPFS:", error);
          throw error;
        }
      })
    );
  }

  private async processBatch() {
    if (this.processing) {
      console.log("Batch processing already in progress...");
      return;
    }

    this.processing = true;
    console.log("Starting batch processing...");

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        console.log(`Processing batch of ${batch.length} items...`);

        const gasPrice = await this.provider.getFeeData();
        if (!gasPrice.maxFeePerGas) {
          throw new Error("Failed to get gas price");
        }
        this.lastGasPrice = gasPrice.maxFeePerGas;

        try {
          console.log("Uploading metadata for batch...");
          const metadataResults = await this.uploadMetadataInBatch(batch);
          console.log(
            `Uploaded ${metadataResults.length} metadata items successfully`
          );

          for (let i = 0; i < metadataResults.length; i++) {
            const { request, ipfsUrl } = metadataResults[i];
            const nonce = this.currentNonce + i;

            try {
              console.log(`Estimating gas for mint #${i + 1}...`);
              const estimatedGas = await this.contract.safeMint.estimateGas(
                request.mintToAddress,
                ipfsUrl
              );

              const safeGasLimit = (estimatedGas * BigInt(120)) / BigInt(100);

              console.log(`Minting NFT #${i + 1} with nonce ${nonce}...`);
              const tx = await this.contract.safeMint(
                request.mintToAddress,
                ipfsUrl,
                {
                  nonce,
                  gasLimit: safeGasLimit,
                  maxFeePerGas: gasPrice.maxFeePerGas,
                  maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
                }
              );

              this.pendingTransactions.set(nonce, {
                request,
                retries: 0,
                gasPrice: this.lastGasPrice,
              });

              console.log(`Waiting for transaction ${tx.hash} to be mined...`);
              const receipt = await tx.wait();
              this.pendingTransactions.delete(nonce);

              let tokenId = "0";
              for (const log of receipt.logs) {
                try {
                  const parsedLog = this.contract.interface.parseLog({
                    topics: log.topics,
                    data: log.data,
                  });
                  if (parsedLog && parsedLog.name === "Transfer") {
                    tokenId = parsedLog.args[2].toString();
                    break;
                  }
                } catch (error) {
                  console.error("Error parsing log:", error);
                  continue;
                }
              }

              console.log(
                `NFT #${i + 1} minted successfully with tokenId ${tokenId}`
              );
              request.resolve({
                hash: tx.hash,
                uri: ipfsUrl,
                tokenId,
                blockNumber: receipt.blockNumber,
              });
            } catch (error) {
              console.error(`Error minting NFT #${i + 1}:`, error);
              request.reject(error);
            }
          }

          this.currentNonce += batch.length;
        } catch (error) {
          console.error("Batch processing error:", error);
          batch.forEach((request) => request.reject(error));
        }

        if (this.queue.length > 0) {
          console.log(
            `Waiting ${this.timeWindow}ms before processing next batch...`
          );
          await new Promise((resolve) => setTimeout(resolve, this.timeWindow));
        }
      }
    } catch (error) {
      console.error("Fatal error in batch processing:", error);
      throw error;
    } finally {
      this.processing = false;
      console.log("Batch processing completed");
    }
  }
}

// Export singleton instance
let processor: OptimizedMintProcessor | null = null;

export const getOptimizedMintProcessor = async () => {
  if (!processor) {
    console.log("Initializing OptimizedMintProcessor...");
    try {
      const provider = new ethers.JsonRpcProvider(
        process.env.NEXT_PUBLIC_RPC_URL,
        {
          chainId: Number(process.env.NEXT_PUBLIC_ALLOWED_CHAIN_ID!),
          name: process.env.NEXT_PUBLIC_NAME_OF_CHAIN!,
        }
      );

      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
      const contract = new ethers.Contract(
        process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS!,
        EZDRM_NFT_CONTRACT_ABI,
        wallet
      );

      processor = new OptimizedMintProcessor(provider, wallet, contract);
      await processor.initialize();
      console.log("OptimizedMintProcessor initialized successfully");
    } catch (error) {
      console.error("Failed to initialize OptimizedMintProcessor:", error);
      throw error;
    }
  }

  return processor;
};

export const optimizedMintNft = async (
  metadataInfo: MetadataInfo,
  mintToAddress: string
) => {
  try {
    console.log(`Requesting mint for address: ${mintToAddress}`);
    const processor = await getOptimizedMintProcessor();
    return processor.addToQueue(metadataInfo, mintToAddress);
  } catch (error) {
    console.error("Error in optimizedMintNft:", error);
    throw error;
  }
};
