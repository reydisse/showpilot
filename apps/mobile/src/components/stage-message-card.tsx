import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { decodeStageMessage } from "@showpilot/shared";
import { Pressable, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { AppField } from "./app-field";
import {
  useStageMessage,
  type StageMessageReview,
} from "../hooks/use-stage-message";
import { commandMobileRundownChange } from "../lib/mobile-api";
import { useAppTheme } from "@/theme/tokens";
export function StageMessageCard({
  scope,
  canWrite,
  ready,
  revision,
  message,
}: {
  scope: { orgId: string; userId: string; showId: string; serviceDate: string };
  canWrite: boolean;
  ready: boolean;
  revision: number;
  message: string;
}) {
  const { colors } = useAppTheme(),
    client = useQueryClient();
  const state = useStageMessage(scope, {
    active: canWrite,
    ready,
    revision,
    message,
    send: commandMobileRundownChange,
    refresh: async (signal) => {
      await client.invalidateQueries(
        {
          queryKey: ["mobile-rundown", scope.orgId, scope.showId, scope.userId],
        },
        { throwOnError: true },
      );
      if (signal.aborted) throw new Error("Show refresh cancelled.");
    },
  });
  const [review, setReview] = useState<StageMessageReview | null>(null);
  const { draft, attempt } = state;
  const current = decodeStageMessage(message),
    reviewed = review ? decodeStageMessage(review.current) : null;
  const locked = !!review || !!attempt || !draft || !canWrite;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  const heading = { ...text, fontWeight: "700" as const };
  const group = { gap: 12 };
  return (
    <View
      style={{
        ...group,
        padding: 16,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        backgroundColor: colors.panel,
      }}
    >
      <Text style={heading}>STAGE MESSAGE</Text>
      <View
        style={{
          ...group,
          padding: 12,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 12,
        }}
      >
        <Text style={heading}>
          {ready ? "Current stage message" : "Last known stage message"}
          {current.priority ? " · Priority" : ""}
        </Text>
        <Text style={text}>
          {message
            ? current.text
            : ready
              ? "No message is displayed."
              : "Current stage message is unavailable while reconnecting."}
        </Text>
      </View>
      {canWrite ? (
        <>
          <Text style={text}>
            Your draft is separate from the displayed message. It is kept when
            you leave this screen during this app session.
          </Text>
          {!ready ? (
            <Text
              accessibilityRole="alert"
              style={{ ...text, color: colors.amberText }}
            >
              Reconnect to the live rundown before reviewing, sending or
              clearing a message.
            </Text>
          ) : null}
          <AppField
            label="Stage message"
            error={
              draft && draft.text.length > 1980
                ? "Shorten this draft to 1,980 characters before sending."
                : undefined
            }
            editable={!locked}
            maxLength={1980}
            multiline
            style={{
              minHeight: 100,
              textAlignVertical: "top",
              paddingVertical: 12,
            }}
            value={draft?.text ?? ""}
            onChangeText={(text) => state.setFields({ text })}
          />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="Priority stage message"
            aria-checked={draft?.priority ?? false}
            accessibilityState={{
              checked: draft?.priority ?? false,
              disabled: locked,
            }}
            disabled={locked}
            onPress={() => state.setFields({ priority: !draft?.priority })}
            style={{
              minHeight: 52,
              padding: 12,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
              justifyContent: "center",
              backgroundColor: draft?.priority
                ? colors.amberSoft
                : colors.panel,
            }}
          >
            <Text style={heading}>
              Priority message: {draft?.priority ? "On" : "Off"}
            </Text>
            <Text style={text}>
              Uses the urgent treatment on confidence displays.
            </Text>
          </Pressable>
          <AppButton
            label="Send message"
            disabled={
              !ready ||
              locked ||
              !draft?.text.trim() ||
              (draft?.text.length ?? 0) > 1980
            }
            onPress={() => setReview(state.prepare("send"))}
          />
          <AppButton
            label="Clear stage message"
            variant="danger"
            disabled={!ready || locked || !message}
            onPress={() => setReview(state.prepare("clear"))}
          />
          <AppButton
            label="Use current message in draft"
            variant="secondary"
            disabled={!ready || locked}
            onPress={() => setReview(state.prepare("replace-draft"))}
          />
        </>
      ) : null}
      {review ? (
        <View
          style={{
            ...group,
            padding: 12,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 12,
          }}
        >
          <Text style={heading}>
            {review.kind === "send"
              ? "Send this message to stage displays?"
              : review.kind === "clear"
                ? "Clear the displayed stage message?"
                : "Replace your draft with the current message?"}
          </Text>
          <Text style={text}>
            Reviewed current message{reviewed?.priority ? " · Priority" : ""}:{" "}
            {reviewed?.text || "No message"}
          </Text>
          {review.kind === "send" ? (
            <>
              <Text style={heading}>
                Message to send{review.fields.priority ? " · Priority" : ""}
              </Text>
              <Text style={text}>{review.fields.text.trim()}</Text>
              <Text style={text}>
                This replaces the stage message for operators and displays
                following this show.
              </Text>
            </>
          ) : null}
          {review.kind === "clear" ? (
            <Text style={text}>
              This removes the displayed message for this show. Your unsent
              draft is kept.
            </Text>
          ) : null}
          {review.kind === "replace-draft" ? (
            <Text style={text}>
              Your unsent text and priority choice will be replaced. The
              displayed message will not change.
            </Text>
          ) : null}
          {!state.canConfirm(review) ? (
            <>
              <Text
                accessibilityRole="alert"
                style={{ ...text, color: colors.red }}
              >
                The rundown or access changed. Review the current message again
                before continuing.
              </Text>
              <AppButton
                label="Review current stage message again"
                variant="secondary"
                disabled={!ready || !canWrite || !!attempt}
                onPress={() => setReview(state.prepare(review.kind))}
              />
            </>
          ) : null}
          <AppButton
            label="Keep stage message draft"
            variant="secondary"
            onPress={() => setReview(null)}
          />
          <AppButton
            label={
              review.kind === "send"
                ? "Confirm send stage message"
                : review.kind === "clear"
                  ? "Confirm clear stage message"
                  : "Confirm replace stage draft"
            }
            variant={review.kind === "clear" ? "danger" : "primary"}
            disabled={!state.canConfirm(review)}
            onPress={() => {
              if (state.confirm(review)) setReview(null);
            }}
          />
        </View>
      ) : null}
      {attempt ? (
        <View style={group}>
          <Text style={heading}>{attempt.label}</Text>
          {attempt.kind === "pending" ? (
            <Text accessibilityLiveRegion="polite" style={text}>
              Confirming stage message action… Leaving keeps the request during
              this app session.
            </Text>
          ) : null}
          {attempt.kind === "failed" ? (
            <>
              <Text
                accessibilityRole="alert"
                style={{ ...text, color: colors.red }}
              >
                {attempt.message}
              </Text>
              <AppButton
                label="Retry original stage message action"
                disabled={!ready || !canWrite}
                onPress={state.retry}
              />
            </>
          ) : null}
          {attempt.kind === "confirmed" ? (
            <>
              <Text accessibilityLiveRegion="polite" style={text}>
                {attempt.result.outcome === "applied"
                  ? "Action accepted. The current message may include later changes from another operator."
                  : attempt.result.outcome === "conflict"
                    ? "The rundown changed. This request was not applied again. Your draft is kept; review the current message before another action."
                    : "This action is no longer available. Your draft is kept."}
              </Text>
              {attempt.refresh !== "done" ? (
                <>
                  <Text
                    accessibilityRole={
                      attempt.refresh === "failed" ? "alert" : undefined
                    }
                    style={text}
                  >
                    {attempt.message ?? "Refreshing the show…"}
                  </Text>
                  <AppButton
                    label="Refresh stage message result"
                    variant="secondary"
                    disabled={
                      !ready || !canWrite || attempt.refresh === "pending"
                    }
                    onPress={state.refresh}
                  />
                </>
              ) : (
                <AppButton
                  label="Continue editing stage message"
                  variant="secondary"
                  disabled={!canWrite}
                  onPress={state.dismiss}
                />
              )}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
