import {Content, elizaLogger, IAgentRuntime} from "@elizaos/core";

export interface YourActionContent extends Content {
  // Define your required fields
  name: string;
  symbol: string;
}


export function isYourActionContent(_runtime: IAgentRuntime, content: any): content is YourActionContent {
  elizaLogger.debug('Content for validation', content);
  return typeof content.name === 'string' && typeof content.symbol === 'string';
}
