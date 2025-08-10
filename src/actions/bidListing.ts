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
import { z } from "zod";
import { initWalletProvider, WalletProvider } from "../providers/wallet";
import { getMinBid, getNextValidBidAmount, isAuctionEnded } from "../services/nft-marketplace/listingData";
import { bidOnAuction } from "../services/nft-marketplace/listingTransactions";
import { toNano } from "@ton/ton";

/**
 * Schema for bid input.
 * Requires:
 * - nftAddress: The NFT contract address.
 * - Optional: bidAmount: The amount to bid (in nanoTON).
 */
const bidAuctionSchema = z
  .object({
    nftAddress: z.string().nonempty("NFT address is required"),
    bidAmount: z.string().optional(),
  })
  .refine(
    (data) => data.nftAddress,
    {
      message: "NFT address is required",
      path: ["nftAddress"],
    }
  );

export interface BidAuctionContent extends Content {
  nftAddress: string;
  bidAmount?: string;
}

function isBidAuctionContent(
  content: Content
): content is BidAuctionContent {
  return typeof content.nftAddress === "string";
}

const bidAuctionTemplate = `Respond with an XML block containing only the extracted values. Use key-value pairs. Use <null/> for any values that cannot be determined.

Example response:
<response>
    <nftAddress>&lt;NFT address to bid on&gt;</nftAddress>
    <bidAmount>&lt;optional bid amount in TON&gt;</bidAmount>
</response>

{{recentMessages}}

If no bid amount is provided, make <bidAmount> a <null/> element or omit it.
Respond with an XML block containing only the extracted values. Use key-value pairs.`;


/**
 * Helper function to build bid parameters.
 */
const buildBidAuctionData = async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State
): Promise<BidAuctionContent> => {
  const context = composePromptFromState({
    state,
    template: bidAuctionTemplate,
  });
  const result = await runtime.useModel(ModelClass.TEXT_SMALL, {
    runtime,
    context,
    schema: bidAuctionSchema as any,
  });
  const content = parseKeyValueXml(result);
  return content as any;
};

/**
 * BidAuctionAction encapsulates the logic to bid on an NFT auction.
 */
export class BidAuctionAction {
  private walletProvider: WalletProvider;

  constructor(walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
  }

  /**
   * Validates whether the auction is valid for bidding
   */
  async validateAuction(nftAddress: string): Promise<{valid: boolean, message?: string}> {
    try {
      // Check if auction has ended
      const auctionEnded = await isAuctionEnded(this.walletProvider, nftAddress);
      if (auctionEnded) {
        return { valid: false, message: "This auction has already ended" };
      }

      return { valid: true };
    } catch (error: any) {
      if (error.message.includes("Not an auction listing")) {
        return { valid: false, message: "This is not an auction. Please use BUY_LISTING instead" };
      }
      throw error;
    }
  }

  /**
   * Places a bid on an NFT auction
   */
  async bid(nftAddress: string, bidAmount?: string): Promise<any> {
    try {
      elizaLogger.log(`Starting bid process for NFT: ${nftAddress}`);

      // First validate the auction
      const validationResult = await this.validateAuction(nftAddress);
      if (!validationResult.valid) {
        throw new Error(validationResult.message);
      }

      // Determine the bid amount
      let amount: bigint;
      if(!bidAmount) {
          amount = await getNextValidBidAmount(this.walletProvider, nftAddress);
      } else {
          amount = toNano(bidAmount);
      }

      // Place the bid
      const receipt = await bidOnAuction(this.walletProvider, nftAddress, amount);

      return receipt;
    } catch (error) {
      elizaLogger.error(`Error bidding on NFT ${nftAddress}: ${error}`);
      // @ts-ignore
      throw new Error(`Failed to bid on NFT: ${error.message}`);
    }
  }
}

export default {
  name: "BID_AUCTION",
  similes: ["NFT_BID", "PLACE_BID", "BID_NFT", "AUCTION_BID"],
  description:
    "Places a bid on an NFT auction by sending a transaction with the bid amount. If no bid is mentioned, the next valid bid amount is used.",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback?: HandlerCallback
  ) : Promise<ActionResult | void | undefined> => {
    elizaLogger.log("Starting BID_AUCTION handler...");
    const params = await buildBidAuctionData(runtime, message, state);

    if (!isBidAuctionContent(params)) {
      if (callback) {
        callback({
          text: "Unable to process bid request. Invalid content provided.",
          content: { error: "Invalid bid content" },
        });
      }
      return { success: true, error: "Invalid bid content"  };
    }

    try {
      const walletProvider = await initWalletProvider(runtime);
      const bidAuctionAction = new BidAuctionAction(walletProvider);

      const result = await bidAuctionAction.bid(params.nftAddress, params.bidAmount);

      if (callback) {
        callback({
          text: JSON.stringify(result, null, 2),
          content: result,
        });
      }
    } catch (error: any) {
      elizaLogger.error("Error in BID_AUCTION handler:", error);
      if (callback) {
        callback({
          text: `Error in BID_AUCTION: ${error.message}`,
          content: { error: error.message },
        });
      }
    }
    return { success: true, };
  },
  template: bidAuctionTemplate,
  // eslint-disable-next-line
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          nftAddress: "EQNftAuctionAddressExample",
          bidAmount: "5000000000",
          action: "BID_AUCTION",
        },
      },
      {
        name: "{{user1}}",
        content: {
          text: "Bid placed successfully",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          nftAddress: "EQNftAuctionAddressExample",
          action: "BID_AUCTION",
        },
      },
      {
        name: "{{user1}}",
        content: {
          text: "Bid placed successfully with minimum valid bid",
        },
      },
    ]
  ] as ActionExample[][],
} as Action;
