import {
  elizaLogger,
  composePromptFromState,
  parseKeyValueXml,
  ModelType as ModelClass,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  Content, ActionExample, Action, ActionResult,
} from "@elizaos/core";
import { Address, beginCell, internal, toNano } from "@ton/ton";
import { z } from "zod";
import { initWalletProvider, WalletProvider } from "../providers/wallet";
import { uploadFolderToIPFS, updateMetadataFiles, uploadJSONToIPFS, base64ToHex, waitSeqnoContract } from "../utils/util";
import path from "path";

/**
 * Extended interface for NFT metadata update content.
 * - nftAddress: The target NFT smart contract address.
 * - metadata: Partial NFT metadata update. All fields are optional, supporting partial edits.
 *   * storage: Option for metadata storage ("prompt" or "file").
 * Additionally, for on-chain updates, optional fields below enable crafting the new on-chain content:
 * - newCollectionMeta: The new collection metadata URL.
 * - newNftCommonMeta: The new NFT common metadata URL.
 * - royaltyAddress: The address to receive royalties.
 */
export interface UpdateNFTMetadataContent extends Content {
  nftAddress: string;
  storage: "prompt" | "file";
  imagesFolderPath?: string;
  metadataFolderPath?: string;
  metadata?: {
    name?: string;
    description?: string;
    image?: string;
    content_url?: string;
    attributes?: any[];
  };
  newCollectionMeta?: string;
  newNftCommonMeta?: string;
  royaltyPercent?: number;
  royaltyAddress?: string;
}

/**
 * Define schema for updating NFT metadata.
 */
const updateNFTMetadataSchema = z.object({
  nftAddress: z.string().nonempty({ message: "NFT address is required" }),
  storage: z.enum(["prompt", "file"]).default("prompt"),
  imagesFolderPath: z.string().optional(),
  metadataFolderPath: z.string().optional(),
  metadata: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    content_url: z.string().optional(),
    attributes: z.array(z.any()).optional(),
  }).optional(),
  // New fields for on-chain update via custom message:
  newCollectionMeta: z.string().optional(),
  newNftCommonMeta: z.string().optional(),
  royaltyPercent: z.number().optional(),
  royaltyAddress: z.string().optional(),
});

const updateNFTMetadataTemplate = `Respond with an XML block containing only the extracted values. Use key-value pairs.
Use <null/> for any values that cannot be determined.

Example response for NFT with metadata in prompt:
<response>
  <nftAddress>EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4</nftAddress>
  <storage>prompt</storage>
  <royaltyPercent>0.05</royaltyPercent>
  <royaltyAddress>EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4</royaltyAddress>
  <metadata>
    <name>Rare NFT Artwork</name>
    <description>A unique NFT artwork minted on TON</description>
    <image>https://example.com/nft-image.png</image>
  </metadata>
</response>

Example response for file-based storage:
<response>
  <nftAddress>EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4</nftAddress>
  <storage>file</storage>
  <imagesFolderPath>path/to/images</imagesFolderPath>
  <metadataFolderPath>path/to/metadata</metadataFolderPath>
  <royaltyPercent>0.05</royaltyPercent>
  <royaltyAddress>EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4</royaltyAddress>
</response>

{{recentMessages}}

Given the recent messages, extract the following information about the requested NFT metadata update:
- NFT address
- Storage option ("prompt" or "file")
- For "prompt" storage: metadata (name, description, image)
- For "file" storage: images folder path and metadata folder path
- Royalty percent (optional)
- Royalty address (optional)

Respond with an XML block containing only the extracted values. Use key-value pairs.`;

function isUpdateNFTMetadataContent(content: Content): content is UpdateNFTMetadataContent {
  return (
    typeof content.nftAddress === "string" &&
    typeof content.storage === "string" &&
    (content.storage === "prompt" || content.storage === "file")
  );
}

/**
 * Builds the update details by composing the context using the updateNFTMetadataTemplate
 * and generating the desired object using the provided schema.
 */
const buildUpdateDetails = async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<UpdateNFTMetadataContent> => {
  const updateContext = composePromptFromState({
    state,
    template: updateNFTMetadataTemplate,
  });

  const result = await runtime.useModel(ModelClass.TEXT_SMALL, {
    runtime,
    context: updateContext,
    schema: updateNFTMetadataSchema,
  });
  const content = await parseKeyValueXml(result);

  return content as UpdateNFTMetadataContent;
};

/**
 * The UpdateNFTMetadataAction class processes metadata updates.
 */
class UpdateNFTMetadataAction {
  private walletProvider: WalletProvider;

  constructor(walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
  }

  /**
   * Uploads content to IPFS based on storage type
   */
  private async uploadContent(params: UpdateNFTMetadataContent): Promise<{ metadataIpfsHash: string, imagesIpfsHash?: string }> {
    let metadataIpfsHash: string;
    let imagesIpfsHash: string | undefined;

    if (params.storage === "file") {
      if (!params.imagesFolderPath || !params.metadataFolderPath) {
        throw new Error("Image and metadata folder paths are required for file storage");
      }

      elizaLogger.log("Started uploading images to IPFS...");
      imagesIpfsHash = await uploadFolderToIPFS(params.imagesFolderPath);
      elizaLogger.log(
        `Successfully uploaded the pictures to ipfs: https://gateway.pinata.cloud/ipfs/${imagesIpfsHash}`
      );

      elizaLogger.log("Started uploading metadata files to IPFS...");
      await updateMetadataFiles(params.metadataFolderPath, imagesIpfsHash);
      metadataIpfsHash = await uploadFolderToIPFS(params.metadataFolderPath);
      elizaLogger.log(
        `Successfully uploaded the metadata to ipfs: https://gateway.pinata.cloud/ipfs/${metadataIpfsHash}`
      );
      return { metadataIpfsHash, imagesIpfsHash };
    } else if(params.storage === "prompt"){
      if(!params.metadata) {
        throw new Error("Metadata is required for prompt storage");
      }
      metadataIpfsHash = await uploadJSONToIPFS(params.metadata);
      return { metadataIpfsHash };
    }

    throw new Error("Invalid storage type");
  }

  /**
   * Crafts and sends an on-chain update transaction that changes the NFT's content.
   * The message follows the provided example:
   * - Opcode 4 indicates a "change content" operation.
   * - The message body stores a reference to a content cell (built from the new collection meta and NFT common meta)
   *   and a royalty cell.
   */
  private async updateNFTMetadataOnChain(params: UpdateNFTMetadataContent): Promise<string> {
    // Parse the NFT address.
    const nftTonAddress = Address.parse(params.nftAddress);

    // Build the collection metadata cell.
    const collectionMetaCell = beginCell()
      .storeUint(1, 8) // Indicates offchain metadata.
      .storeStringTail(params.newCollectionMeta!)
      .endCell();

    // Build the NFT common metadata cell.
    const nftCommonMetaCell = beginCell()
      .storeUint(1, 8)
      .storeStringTail(params.newNftCommonMeta!)
      .endCell();

    // Build the content cell which contains both references.
    const contentCell = beginCell()
      .storeRef(collectionMetaCell)
      .storeRef(nftCommonMetaCell)
      .endCell();

    // Build the royalty cell.
    const royaltyCell = beginCell()
      .storeUint(params.royaltyPercent! * 100, 16) // factor (e.g., 5% = 500).
      .storeUint(10000, 16) // base.
      .storeAddress(Address.parse(params.royaltyAddress!))
      .endCell();

    // Build the update message body using opcode 4.
    const messageBody = beginCell()
      .storeUint(4, 32) // Opcode for changing content.
      .storeUint(0, 64) // Query id (0).
      .storeRef(contentCell)
      .storeRef(royaltyCell)
      .endCell();

    // Create the internal update message.
    const updateMessage = internal({
      to: nftTonAddress,
      value: toNano("0.05"),
      bounce: true,
      body: messageBody,
    });

    const walletClient = this.walletProvider.getWalletClient();
    const contract = walletClient.open(this.walletProvider.wallet);

    const seqno: number = await contract.getSeqno();
    const transfer = await contract.createTransfer({
      seqno,
      secretKey: this.walletProvider.keypair.secretKey,
      messages: [updateMessage],
    });

    await contract.send(transfer);
    elizaLogger.log("Transaction sent, waiting for confirmation...");

    await waitSeqnoContract(seqno, contract);

    const state = await walletClient.getContractState(
        this.walletProvider.wallet.address,
    );
    if (!state.lastTransaction) {
      return '';
    }
    const { lt: _, hash: lastHash } = state.lastTransaction;
    return base64ToHex(lastHash);
  }

  async update(params: UpdateNFTMetadataContent): Promise<string> {
    const { metadataIpfsHash } = await this.uploadContent(params);

    // Set the new metadata URLs if not already provided
    if (!params.newCollectionMeta) {
      params.newCollectionMeta = `ipfs://${metadataIpfsHash}/collection.json`;
    }

    if (!params.newNftCommonMeta) {
      params.newNftCommonMeta = `ipfs://${metadataIpfsHash}/`;
    }

    return await this.updateNFTMetadataOnChain(params);
  }
}

export default {
  name: "UPDATE_NFT_METADATA",
  similes: ["NFT_UPDATE", "UPDATE_METADATA"],
  description:
    "Updates NFT metadata post-mint. Supports partial or full metadata edits with on-chain or off-chain constraints. For off-chain storage, metadata is uploaded using Helia. For on-chain updates, a custom update message (using opcode 4) is sent, updating content and royalty information.",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult | void | undefined>  => {
    elizaLogger.log("Starting UPDATE_NFT_METADATA handler...");

    const updateDetails = await buildUpdateDetails(runtime, message, state);

    // Validate transfer content
    if (!isUpdateNFTMetadataContent(updateDetails)) {
      if (callback) {
        callback({
          text: "Unable to process update request. Invalid content provided.",
          content: { error: "Invalid update content" },
        });
      }
      return {
        success: false,
        error: "Invalid update content",
      };
    }

    try {
      // Set default paths if using file storage
      if (updateDetails.storage === "file") {
        updateDetails.imagesFolderPath = runtime.getSetting("TON_NFT_IMAGES_FOLDER") ||
          path.join(process.cwd(), "ton_nft_images");
        updateDetails.metadataFolderPath = runtime.getSetting("TON_NFT_METADATA_FOLDER") ||
          path.join(process.cwd(), "ton_nft_metadata");
      }

      // Process the metadata update.
      const walletProvider = await initWalletProvider(runtime);
      const updateAction = new UpdateNFTMetadataAction(walletProvider);
      const hash = await updateAction.update(updateDetails);

      // Prepare the result.
      const result = {
        status: "success",
        nftAddress: updateDetails.nftAddress,
        updatedMetadata: updateDetails.metadata,
        message: "NFT metadata updated successfully",
        hash: hash,
      };

      if (callback) {
        callback({
          text: `NFT metadata updated successfully`,
          content: result,
        });
      }
      return {
        success: true,
      };
    } catch (error: any) {
      elizaLogger.error("Error updating NFT metadata:", error);
      if (callback) {
        callback({
          text: `Error updating NFT metadata: ${error.message}`,
          content: { error: error.message },
        });
      }
      return {
        success: false,
      };
    }
  },
  validate: async (_runtime: IAgentRuntime) => true,
  template: updateNFTMetadataTemplate,
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          nftAddress: "NFT_123456789",
          metadata: {
            name: "Updated NFT Artwork",
            description: "New description for NFT",
            image: "https://example.com/new-image.png",
            storage: "off-chain" // or "on-chain"
          },
          // Fields for on-chain update (if storage is "on-chain")
          newCollectionMeta: "https://example.com/new-collection-meta.json",
          newNftCommonMeta: "https://example.com/new-nft-common-meta.json",
          royaltyAddress: "EQRoyaltyAddressExample",
          action: "UPDATE_NFT_METADATA",
        },
      },
      {
        name: "{{user1}}",
        content: {
          text: "NFT metadata updated successfully",
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

