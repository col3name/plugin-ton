import {
    elizaLogger,
    type Content,
    type HandlerCallback,
    composePromptFromState,
    parseKeyValueXml,
    ModelType as ModelClass,
    type IAgentRuntime,
    type Memory,
    type State, ActionExample,
} from "@elizaos/core";
import { z } from "zod";
import { IStakingProvider, StakingProvider, initStakingProvider } from "../providers/staking";
import { initWalletProvider } from "../providers/wallet";

export interface StakeContent extends Content {
    poolId: string;
    amount: string | number;
}

function isStakeContent(content: Content): content is StakeContent {
    return (
        typeof content.poolId === "string" &&
        (typeof content.amount === "string" ||
            typeof content.amount === "number")
    );
}
const stakeTemplate = `Respond with an XML block containing only the extracted values. Use key-value pairs.
Use <null/> for any values that cannot be determined.

Example response:
<response>
    <poolId>pool123</poolId>
    <amount>1.5</amount>
</response>

{{recentMessages}}

Given the recent messages, extract the following information for staking TON:
- Pool identifier (poolId)
- Amount to stake

Respond with an XML block containing only the extracted values. Use key-value pairs.`;

/**
 * Modified StakeAction class that uses the nativeStakingProvider which
 * internally leverages the current wallet provider to construct and send
 * on-chain transactions.
 */
export class StakeAction {
    constructor(
        private stakingProvider: IStakingProvider,
    ) {}

    async stake(params: StakeContent): Promise<string | null> {
        elizaLogger.log(
            `Staking: ${params.amount} TON in pool (${params.poolId}) using wallet provider`,
        );
        try {
            return await this.stakingProvider.stake(params.poolId, Number(params.amount));
        } catch (error) {
            throw new Error(`Staking failed: ${error.message}`);
        }
    }
}

const buildStakeDetails = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
): Promise<StakeContent> => {
    // Initialize or update state
    if (!state) {
        state = (await runtime.composeState(message)) as State;
    } else {
        state = await runtime.composeState(message, ['RECENT_MESSAGES']);
    }
    // Define the schema for the expected output
    const stakeSchema = z.object({
        poolId: z.string(),
        amount: z.union([z.string(), z.number()]),
    });

    // Compose staking context
    const stakeContext = composePromptFromState({
        state,
        template: stakeTemplate,
    });

    // Generate stake content with the schema
    const result = await runtime.useModel(ModelClass.TEXT_SMALL, {
        runtime,
        context: stakeContext,
        schema: stakeSchema,
    });
    const content = await parseKeyValueXml(result);

    return content as StakeContent;
};

export default {
    name: "DEPOSIT_TON",
    similes: ["STAKE_TOKENS", "DEPOSIT_TON", "DEPOSIT_TOKEN"],
    description: "Deposit TON tokens in a specified pool.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback,
    ) => {
        elizaLogger.log("Starting DEPOSIT_TON handler...");
        const stakeDetails = await buildStakeDetails(runtime, message, state);

        if (!isStakeContent(stakeDetails)) {
            elizaLogger.error("Invalid content for DEPOSIT_TON action.");
            if (callback) {
                callback({
                    text: "Invalid staking details provided.",
                    content: { error: "Invalid staking content" },
                });
            }
            return false;
        }

        try {

            const walletProvider = await initWalletProvider(runtime);
            const stakingProvider = await initStakingProvider(runtime);
            // Instantiate StakeAction with the native staking provider.
            const action = new StakeAction(stakingProvider);
            const txHash = await action.stake(stakeDetails);

            if (callback) {
                callback({
                    text: `Successfully staked ${stakeDetails.amount} TON in pool ${stakeDetails.poolId}. Transaction: ${txHash}`,
                    content: {
                        success: true,
                        hash: txHash,
                        amount: stakeDetails.amount,
                        poolId: stakeDetails.poolId,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error during staking:", error);
            if (callback) {
                callback({
                    text: `Error staking TON: ${error.message}`,
                    content: { error: error.message },
                });
            }
            return false;
        }
    },
    template: stakeTemplate,
    validate: async (runtime: IAgentRuntime) => {
        elizaLogger.info("VALIDATING TON STAKING ACTION")
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Deposit 1.5 TON in pool pool123",
                    action: "DEPOSIT_TON",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll deposit 1.5 TON now...",
                    action: "DEPOSIT_TON",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully deposited 1.5 TON in pool pool123, Transaction: abcd1234efgh5678",
                },
            },
        ],
    ] as ActionExample[][],
};
