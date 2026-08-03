import type Anthropic from '@anthropic-ai/sdk';
import type { ContentPart, ToolSpec, Turn } from 'agent-runtime-core';

/**
 * Render provider-neutral turns to the Anthropic Messages wire format.
 * Contracts:
 *  - prompt caching: cache_control ephemeral goes on the LAST system block;
 *  - consecutive tool_result turns are grouped into ONE user message
 *    (the parallel-tool answer contract — the API rejects orphans).
 */

export const renderSystem = (system: string | undefined): Anthropic.TextBlockParam[] | undefined =>
  system === undefined || system === ''
    ? undefined
    : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];

export const renderTools = (tools: ToolSpec[] | undefined): Anthropic.Tool[] | undefined =>
  tools === undefined || tools.length === 0
    ? undefined
    : tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

export const renderToolChoice = (
  choice: 'auto' | 'any' | 'none' | undefined
): Anthropic.ToolChoice | undefined => (choice === undefined ? undefined : { type: choice });

const renderContentPart = (part: ContentPart): unknown => {
  if ('type' in part && part.type === 'text') return { type: 'text', text: part.text };
  if ('type' in part && part.type === 'image') {
    const p = part as { type: 'image'; mediaType: string; data: string };
    return {
      type: 'image',
      source: { type: 'base64', media_type: p.mediaType, data: p.data },
    };
  }
  return part; // pass-through escape hatch
};

const renderUserContent = (
  content: string | ContentPart[]
): string | Anthropic.ContentBlockParam[] =>
  typeof content === 'string'
    ? content
    : (content.map(renderContentPart) as Anthropic.ContentBlockParam[]);

const toolResultBlock = (turn: Extract<Turn, { role: 'tool_result' }>): unknown => ({
  type: 'tool_result',
  tool_use_id: turn.toolUseId,
  content:
    typeof turn.content === 'string'
      ? turn.content
      : (turn.content.map(renderContentPart) as Anthropic.ContentBlockParam[]),
  ...(turn.isError ? { is_error: true } : {}),
});

export const renderTurns = (turns: Turn[]): Anthropic.MessageParam[] => {
  const messages: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < turns.length) {
    const turn = turns[i]!;
    switch (turn.role) {
      case 'system':
        // System never travels in turns for this adapter — skip defensively.
        i++;
        break;
      case 'user':
        messages.push({ role: 'user', content: renderUserContent(turn.content) });
        i++;
        break;
      case 'assistant': {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (turn.content !== '') blocks.push({ type: 'text', text: turn.content });
        for (const call of turn.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input ?? {},
          });
        }
        // An assistant turn with no text and no tool calls is unrepresentable
        // on the wire — skip it.
        if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
        i++;
        break;
      }
      case 'tool_result': {
        // Group the whole consecutive run into ONE user message.
        const group: Anthropic.ContentBlockParam[] = [];
        while (i < turns.length && turns[i]!.role === 'tool_result') {
          group.push(
            toolResultBlock(
              turns[i] as Extract<Turn, { role: 'tool_result' }>
            ) as Anthropic.ContentBlockParam
          );
          i++;
        }
        messages.push({ role: 'user', content: group });
        break;
      }
    }
  }
  return messages;
};
