import { optimizedMintNft } from "./optimizedMint";
import { MetadataInfo } from "./minNft";
import "dotenv/config";

async function testBatchMinting() {
  try {
    // Test data
    const testMetadata: MetadataInfo = {
      name: "Test NFT",
      description: "Test NFT Description",
      image: "https://example.com/image.png",
      attributes: [
        {
          trait_type: "Test Trait",
          value: "Test Value",
        },
      ],
    };

    const testAddress = process.env.TEST_WALLET_ADDRESS!;
    const batchSize = 2; // Start with a smaller test batch

    console.log(`Starting batch mint test with ${batchSize} NFTs...`);
    console.log(`Minting to address: ${testAddress}`);

    // Create array of mint promises
    const mintPromises = Array(batchSize)
      .fill(null)
      .map(async (_, index) => {
        const metadata: MetadataInfo = {
          ...testMetadata,
          name: `Test NFT #${index + 1}`,
        };

        try {
          console.log(`Attempting to mint NFT #${index + 1}...`);
          const result = await optimizedMintNft(metadata, testAddress);
          console.log(`✅ NFT #${index + 1} minted successfully:`, {
            tokenId: result.tokenId,
            hash: result.hash,
            uri: result.uri,
          });
          return result;
        } catch (error) {
          console.error(`❌ Failed to mint NFT #${index + 1}:`, error);
          return null;
        }
      });

    // Wait for all mints to complete
    const results = await Promise.all(mintPromises);
    const successfulResults = results.filter((r) => r !== null);

    console.log("\nMinting Summary:");
    console.log("Total NFTs attempted:", batchSize);
    console.log("Successfully minted:", successfulResults.length);
    if (successfulResults.length > 0) {
      console.log(
        "All token IDs:",
        successfulResults.map((r) => r?.tokenId).join(", ")
      );
    }
  } catch (error) {
    console.error("Batch minting failed:", error);
  }
}

// Test with larger batch
async function testLargeBatchMinting(batchSize: number = 10) {
  // Reduced default size for initial testing
  console.log(`Starting large batch mint test with ${batchSize} NFTs...`);
  console.log(`Minting to address: ${process.env.TEST_WALLET_ADDRESS}`);

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  // Process in smaller chunks to avoid overwhelming the system
  const chunkSize = 2; // Reduced chunk size for initial testing
  for (let i = 0; i < batchSize; i += chunkSize) {
    const currentBatchSize = Math.min(chunkSize, batchSize - i);
    console.log(
      `\nProcessing batch ${i / chunkSize + 1}/${Math.ceil(
        batchSize / chunkSize
      )}...`
    );

    const promises = Array(currentBatchSize)
      .fill(null)
      .map(async (_, index) => {
        const metadata: MetadataInfo = {
          name: `Large Batch NFT #${i + index + 1}`,
          description: "Test NFT from large batch",
          image: "https://example.com/image.png",
          attributes: [
            {
              trait_type: "Batch",
              value: `${Math.floor(i / chunkSize) + 1}`,
            },
          ],
        };

        try {
          console.log(`Attempting to mint NFT #${i + index + 1}...`);
          const result = await optimizedMintNft(
            metadata,
            process.env.TEST_WALLET_ADDRESS!
          );
          successCount++;
          console.log(`✅ Successfully minted NFT #${i + index + 1}:`, {
            tokenId: result.tokenId,
            hash: result.hash,
          });
          return result;
        } catch (error) {
          failCount++;
          console.error(`❌ Failed to mint NFT #${i + index + 1}:`, error);
          return null;
        }
      });

    const batchResults = await Promise.all(promises);
    const successfulBatchResults = batchResults.filter((r) => r !== null);

    // Progress update
    const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
    console.log(`\nBatch Progress Update:`);
    console.log(
      `Processed in this batch: ${successfulBatchResults.length}/${currentBatchSize}`
    );
    console.log(`Total processed: ${i + currentBatchSize}/${batchSize} NFTs`);
    console.log(`Total success: ${successCount}, Total failed: ${failCount}`);
    console.log(`Time elapsed: ${elapsedMinutes.toFixed(2)} minutes`);

    if (i + currentBatchSize < batchSize) {
      const estimatedRemaining =
        (elapsedMinutes / (i + currentBatchSize)) *
        (batchSize - (i + currentBatchSize));
      console.log(
        `Estimated time remaining: ${estimatedRemaining.toFixed(2)} minutes`
      );

      // Add a small delay between batches
      console.log("Waiting 5 seconds before next batch...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  const totalTime = (Date.now() - startTime) / 1000 / 60;
  console.log("\nFinal Results:");
  console.log(`Total time: ${totalTime.toFixed(2)} minutes`);
  console.log(`Successfully minted: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(
    `Average time per NFT: ${((totalTime * 60) / batchSize).toFixed(2)} seconds`
  );
}

// Run tests
async function runTests() {
  if (!process.env.TEST_WALLET_ADDRESS) {
    console.error("Please set TEST_WALLET_ADDRESS in your .env file");
    process.exit(1);
  }

  try {
    // First test with small batch
    console.log("Running small batch test...");
    await testBatchMinting();

    // Wait a bit before running large batch test
    console.log("\nWaiting 5 seconds before starting large batch test...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Then test with larger batch
    console.log("\nRunning large batch test...");
    await testLargeBatchMinting(4); // Start with a small number for testing
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  }
}

// Run the tests
runTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
