import {
  elizaLogger,
  type Content,
  type HandlerCallback,
  composePromptFromState,
  parseKeyValueXml,
  ModelType as ModelClass,
  type IAgentRuntime,
  type Memory,
  type State,
  ActionExample,
  Action,
} from "@elizaos/core";
import {z} from "zod";
import {
  nativeWalletProvider,
} from "../providers/wallet";


import {validateEnvConfig} from "../enviroment";
import {initStonProvider} from "../providers/ston";


export interface IQueryAssetContent extends Content {
  token: string;
}

function isQueryAssetContent(content: Content): content is IQueryAssetContent {
  return (
    typeof content.token === "string"
  );
}


const queryAssetSchema = z.object({
  token: z.string().min(1, {message: "A token is required to fetch information."}),
});
const queryAssetTemplate = `Respond with an XML block containing only the extracted values. Use key-value pairs.
Use <null/> for any values that cannot be determined.

Example response:
<response>
    <token>{{dynamic}}</token>
</response>

{{recentMessages}}

Given the recent messages, extract the following information about the requested token transfer:
- token

Respond with an XML block containing only the extracted values. Use key-value pairs.`;

const buildQueryAssetDetails = async (
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
): Promise<IQueryAssetContent> => {

  const walletInfo = await nativeWalletProvider.get(runtime, message, state);
  state.walletInfo = walletInfo;

  let currentState = state;
  if (!currentState) {
    currentState = (await runtime.composeState(message)) as State;
  } else {
    currentState = await runtime.composeState(message, ['RECENT_MESSAGES']);
  }

  // Compose swap context
  const queryAssetContext = composePromptFromState({
    state: currentState,
    template: queryAssetTemplate,
  });

  // Generate swap content with the schema
  const result = await runtime.useModel(ModelClass.TEXT_SMALL, {
    runtime,
    context: queryAssetContext,
    schema: queryAssetSchema,
  });

  const content = await parseKeyValueXml(result);

  let queryAssetContent: IQueryAssetContent = content as IQueryAssetContent;

  if (queryAssetContent === undefined) {
    queryAssetContent = content as unknown as IQueryAssetContent;
  }

  return queryAssetContent;
};


// @ts-ignore
export default {
  name: "QUERY_STON_ASSET",
  similes: ["QUERY_STON_ASSET", "QUERY_STON_ASSETS", "QUERY_STON_ASSET_INFO", "QUERY_STON_ASSET_INFORMATION"],
  template: queryAssetTemplate,
  description: "Query information about a token in the TON blockchain through STON.fi DEX",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    elizaLogger.log("Validating config for name:", message.entityId);
    await validateEnvConfig(runtime);
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    elizaLogger.log("Starting QUERY_STON_ASSET handler...");
    //
    elizaLogger.log("Handler initialized. Checking user authorization...");
    //
    const queryAssetContent = await buildQueryAssetDetails(
      runtime,
      message,
      state,
    );

    try {
      // Validate transfer content
      if (!isQueryAssetContent(queryAssetContent)) {
          throw new Error("Invalid content for QUERY_STON_ASSET action.");
      }
      const stonProvider = await initStonProvider(runtime);
      // Check if tokens are part of available assets and the pair of tokens is also defined
      const token = await stonProvider.getAsset(queryAssetContent.token);

      elizaLogger.success(`Successfully queried ${queryAssetContent.token} in STON DEX`);

      const template = `
      # Task: generate a dialog line from {{agentName}} to communicate {{user1}} that the query of the token ${queryAssetContent.token} was successful.
      Avoid adding initial and final quotes.
      The dialog line should be only one message and include the following information of the token:
      - price in USD ${token.dexPriceUsd} USD
      - popularity index ${token.popularityIndex}
      - is blacklisted? ${token.blacklisted}
      - is deprecated? ${token.deprecated}
      - display name ${token.displayName}
      - contract address ${token.contractAddress}
      - liquidity of the token ${token.tags.filter(tag => tag.startsWith('asset:liquidity:') || tag.includes('_liquidity'))
        .map(tag => tag.replace('asset:liquidity:', '').replace('_liquidity', '').replace('_', ' '))[0]}
      - is popular? ${token.tags.includes('asset:popular')}
      `;
      const responseContext = composePromptFromState({
          state,
          template
      });
      const response = await runtime.useModel(ModelClass.TEXT_SMALL, {
          runtime: runtime,
          context: responseContext,
      });

      if (callback) {
        callback?.({
            text: response,
            content: {
                success: true,
                balance: token.balance,
                dexPriceUsd: token.dexPriceUsd,
                popularityIndex: token.popularityIndex,
                blacklisted: token.blacklisted,
                deprecated: token.deprecated,
                displayName: token.displayName,
                contractAddress: token.contractAddress,
                liquidity: token.tags.filter(tag => tag.startsWith('asset:liquidity:') || tag.includes('_liquidity'))
                  .map(tag => tag.replace('asset:liquidity:', '').replace('_liquidity', '').replace('_', ' '))[0],
            },
        });
      }
      return true;
    } catch (error) {
      elizaLogger.error("Error during token query: ", error);

      const template = `
            // # Task: generate a dialog line from the character {{agentName}} to communicate {{user1}} that the query failed due to ${error.message}.
            // The dialog line should be only one message and contain al the information of the error.
            // Avoid adding initial and final quotes.
            // `;
      //
      // const responseContext = composePromptFromState({
      //     state,
      //     template
      // });
      // const response = await runtime.useModel(ModelClass.TEXT_SMALL, {
      //     runtime: runtime,
      //     context: responseContext,
      // });
      //
      // await callback?.({
      //     text: response,
      //     error: {
      //         message: error?.message,
      //         statusCode: error?.response?.status,
      //     }
      // });

      return false;
    }
  },
  examples: [
    [
        {
            name: "{{user1}}",
            content: {
                text: "Query TON asset in STON DEX",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "Querying TON Asset in STON DEX...",
                action: "QUERY_STON_ASSET",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "Successfully queried TON Asset in STON DEX. It's currently priced at {{dynamic}} USDC.",
            },
        }
    ],
    [
        {
            name: "{{user1}}",
            content: {
                text: "What is the price of TON in STON DEX?",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "Querying TON Asset in STON DEX...",
                action: "QUERY_STON_ASSET",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "It's currently priced at {{dynamic}} USDC.",
            },
        },
    ],
    [
        {
            name: "{{user1}}",
            content: {
                text: "What is the liquidity of STON in STON DEX?",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "Querying STON Asset in STON DEX...",
                action: "QUERY_STON_ASSET",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "It's liquidity is {{dynamic}}.",
            },
        },
    ],
    [
        {
            name: "{{user1}}",
            content: {
                text: "What is the liquidity of USRC in STON DEX?",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "Querying USRC Asset in STON DEX...",
                action: "QUERY_STON_ASSET",
            },
        },
        {
            name: "{{agent}}",
            content: {
                text: "It's currently blacklisted.",
            },
        },
    ],
  ] as ActionExample[][],
} as Action;
