import type { MeetingBridgeMessageSender } from './MeetingBridge.js';
import type { TmuxSessionTarget } from './TmuxSessionMessenger.js';
import { TmuxSessionMessenger } from './TmuxSessionMessenger.js';

interface RemoteTmuxMessageRequest {
  originId: string;
  tmuxSession: string;
  message: string;
  pressEnter?: boolean;
}

type RemoteTmuxMessageSender = (request: RemoteTmuxMessageRequest) => Promise<void>;

function isAmbiguousRemoteTmuxDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnected|didn't acknowledge|did not acknowledge|timeout|timed out/i.test(message);
}

export class AgentAwareMeetingMessenger implements MeetingBridgeMessageSender {
  constructor(
    private readonly sendRemoteTmuxMessage: RemoteTmuxMessageSender,
    private readonly fallback: MeetingBridgeMessageSender = new TmuxSessionMessenger(),
  ) {}

  send(target: TmuxSessionTarget, message: string, options: { pressEnter?: boolean } = {}): void {
    const meetingTarget = target as TmuxSessionTarget & { originId?: string };
    if (!meetingTarget.originId || meetingTarget.originId === 'local') {
      this.fallback.send(target, message, options);
      return;
    }

    void this.sendRemoteTmuxMessage({
      originId: meetingTarget.originId,
      tmuxSession: target.tmuxSession,
      message,
      pressEnter: options.pressEnter ?? false,
    }).catch((error) => {
      if (isAmbiguousRemoteTmuxDeliveryError(error)) {
        console.warn(
          '[MeetingBridge] remote bootstrap tmux-message delivery ambiguous; not falling back to SSH',
          error instanceof Error ? error.message : error,
        );
        return;
      }

      console.warn(
        '[MeetingBridge] remote bootstrap tmux-message via agent failed; falling back to tmux messenger',
        error instanceof Error ? error.message : error,
      );
      this.fallback.send(target, message, options);
    });
  }
}
