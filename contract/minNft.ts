import { ethers } from "ethers";
import { EZDRM_NFT_CONTRACT_ABI } from "./abi";
import axios from "axios";

interface PinataResponse {
  success: boolean;
  urlTransactionHash: string | null;
  message: string;
}

export interface MetadataInfo {
  name: string;
  description: string;
  image: string;
  attributes?: Array<{
    trait_type: string;
    value: string | number;
  }>;
}

export const mintNft = async (
  metadataInfo: MetadataInfo,
  mintToAddress: string
): Promise<{
  hash: string;
  uri: string | null;
  tokenId: string;
  blockNumber: number;
}> => {
  try {
    const provider = new ethers.JsonRpcProvider(
      process.env.NEXT_PUBLIC_RPC_URL,
      {
        chainId: Number(process.env.NEXT_PUBLIC_ALLOWED_CHAIN_ID!),
        name: process.env.NEXT_PUBLIC_NAME_OF_CHAIN!,
      },
      { staticNetwork: true }
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const contract = new ethers.Contract(
      process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS!,
      EZDRM_NFT_CONTRACT_ABI,
      wallet
    );

    // get latest block, fee data and metadata
    const [latestBlock, feeData, metadata] = await Promise.all([
      provider.getBlock("latest"),
      provider.getFeeData(),
      uploadFileToAppPinata(metadataInfo),
    ]);

    if (!latestBlock) throw new Error("Could not get latest block");

    const baseFee = latestBlock.baseFeePerGas;
    if (!baseFee) throw new Error("Could not get base fee");
    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      throw new Error("Could not get fee data");
    }

    const uri = metadata.urlTransactionHash;

    const etmGas = await contract.safeMint.estimateGas(mintToAddress, uri, {
      from: wallet.address,
    });

    const tx = await contract.safeMint(mintToAddress, uri, {
      gasLimit: etmGas,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      from: wallet.address,
    });

    const receipt = await tx.wait();
    let tokenId = "0";
    for (const log of receipt.logs) {
      try {
        const parsedLog = contract.interface.parseLog({
          topics: log.topics,
          data: log.data,
        });

        if (parsedLog && parsedLog.name === "Transfer") {
          // Transfer(address from, address to, uint256 tokenId)
          tokenId = parsedLog.args[2].toString();
          console.log("Found tokenId from Transfer event:", tokenId);
          break;
        }
      } catch (error) {
        continue;
      }
    }

    return {
      hash: tx.hash,
      uri: uri,
      tokenId,
      blockNumber: receipt.blockNumber,
    };
  } catch (error) {
    console.error("Error in mintNft:", error);
    throw error;
  }
};

const uploadFileToAppPinata = async (
  metadataInfo: MetadataInfo
): Promise<PinataResponse> => {
  try {
    // Validate environment variables
    const url = process.env.PINATA_URL;
    const JWT = process.env.PINATA_JWT;
    const PINATA_API_KEY = process.env.PINATA_API_KEY;
    const PINATA_SECRET_API_KEY = process.env.PINATA_SECRET_API_KEY;
    const PINATA_CLOUD_URL = process.env.PINATA_CLOUD_URL;

    if (
      !url ||
      !JWT ||
      !PINATA_API_KEY ||
      !PINATA_SECRET_API_KEY ||
      !PINATA_CLOUD_URL
    ) {
      console.error("Missing Pinata configuration:", {
        url: !!url,
        jwt: !!JWT,
        apiKey: !!PINATA_API_KEY,
        secretKey: !!PINATA_SECRET_API_KEY,
        cloudUrl: !!PINATA_CLOUD_URL,
      });
      return {
        success: false,
        urlTransactionHash: null,
        message: "Missing Pinata configuration in environment variables",
      };
    }

    // Create form data
    const form = new FormData();
    const metadataBlob = new Blob([JSON.stringify(metadataInfo)], {
      type: "application/json",
    });
    form.append("file", metadataBlob, "metadata.json");

    // Add pinata options
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

    // Upload to Pinata with all authentication methods
    const response = await axios.post(url, form, {
      maxBodyLength: Infinity,
      headers: {
        "Content-Type": `multipart/form-data`,
        Authorization: `Bearer ${JWT}`,
        pinata_api_key: PINATA_API_KEY,
        pinata_secret_api_key: PINATA_SECRET_API_KEY,
      },
    });

    if (!response.data.IpfsHash) {
      console.error("Pinata response missing IpfsHash:", response.data);
      return {
        success: false,
        urlTransactionHash: null,
        message: "Failed to get IPFS hash from Pinata",
      };
    }

    const ipfsUrl = `${PINATA_CLOUD_URL}${response.data.IpfsHash}`;
    return {
      success: true,
      urlTransactionHash: ipfsUrl,
      message: "Metadata pinned successfully to IPFS",
    };
  } catch (error: any) {
    console.error("Error when mint nft:", {
      message: error.message,
      response: error.response?.data,
    });
    return {
      success: false,
      urlTransactionHash: null,
      message:
        error.response?.data?.error?.details ||
        error.message ||
        "Error uploading to Pinata",
    };
  }
};
