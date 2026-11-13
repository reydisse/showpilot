import { useState } from "react";
import { Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";
import type { useRundownItemEditor } from "../hooks/use-rundown-item-editor";
import type { RundownItem } from "../lib/mobile-api";
import { durationInput } from "../lib/rundown-item-draft";
export function RundownItemRecovery({
  state,
  revision,
  serviceDate,
  items,
  canEdit,
  onClose,
}: {
  state: ReturnType<typeof useRundownItemEditor>;
  revision: number;
  serviceDate: string;
  items: RundownItem[];
  canEdit: boolean;
  onClose: () => void;
}) {
  const { colors } = useAppTheme();
  const [discarding, setDiscarding] = useState(false);
  const [review, setReview] = useState<{
    revision: number;
    serviceDate: string;
    items: RundownItem[];
  } | null>(null);
  const { draft, attempt } = state;
  if (!draft) return null;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 },
    error = { ...text, color: colors.red };
  const settled =
    !attempt || (attempt.kind === "confirmed" && attempt.refresh === "done");
  const changed =
    draft.base.revision !== revision || draft.base.serviceDate !== serviceDate;
  const currentItem = items.find((i) => i.id === draft.id);
  const missing = !!draft.base.item && !currentItem;
  const snapshotReady =
    attempt?.kind !== "confirmed" ||
    attempt.result.revision === null ||
    revision >= attempt.result.revision;
  const reviewedItem = review?.items.find((i) => i.id === draft.id);
  const finish = () => {
    if (state.discard()) onClose();
  };
  return (
    <View style={{ gap: 12 }}>
      <Text style={text}>
        Closing keeps this draft during this app session. Resume it from the
        rundown.
      </Text>
      {!canEdit ? (
        <Text accessibilityRole="alert" style={error}>
          Reconnect with editing access before submitting or retrying. Your
          draft is retained.
        </Text>
      ) : null}
      {attempt?.kind === "pending" ? (
        <Text accessibilityLiveRegion="polite" style={text}>
          Confirming {attempt.label.toLowerCase()}…
        </Text>
      ) : null}
      {attempt?.kind === "failed" ? (
        <>
          <Text accessibilityRole="alert" style={error}>
            {attempt.message}
          </Text>
          <AppButton
            label="Retry original item edit"
            disabled={!canEdit}
            onPress={state.retry}
          />
        </>
      ) : null}
      {attempt?.kind === "confirmed" ? (
        <>
          <Text accessibilityLiveRegion="polite" style={text}>
            {attempt.result.outcome === "applied"
              ? "Edit accepted. The rundown may include later changes by other operators."
              : attempt.result.outcome === "conflict"
                ? "The rundown changed. This request was not applied again. Review the current rundown before trying another edit."
                : "This edit is no longer available. Your draft has been kept."}
          </Text>
          {attempt.refresh !== "done" ? (
            <>
              <Text
                accessibilityRole={
                  attempt.refresh === "failed" ? "alert" : undefined
                }
                style={text}
              >
                {attempt.message ?? "Refreshing the rundown…"}
              </Text>
              <AppButton
                label="Refresh item edit result"
                disabled={!canEdit || attempt.refresh === "pending"}
                onPress={state.refresh}
              />
            </>
          ) : null}
          {settled &&
          attempt.result.outcome === "applied" &&
          attempt.command.action !== "reorder" ? (
            <AppButton label="Finish editing item" onPress={finish} />
          ) : null}
        </>
      ) : null}
      {settled && (changed || attempt) ? (
        <>
          {missing ? (
            <Text accessibilityRole="alert" style={error}>
              This item was removed. Your draft remains available to read or
              copy.
            </Text>
          ) : (
            <>
              <Text style={text}>
                Review the current item and order before continuing with your
                retained fields. Reviewing does not send an edit.
              </Text>
              {!snapshotReady ? (
                <Text style={text}>
                  Waiting for the live rundown to reach the confirmed revision.
                </Text>
              ) : null}
              <AppButton
                label="Review current rundown for item"
                variant="secondary"
                disabled={!canEdit || !snapshotReady}
                onPress={() => setReview({ revision, serviceDate, items })}
              />
            </>
          )}
        </>
      ) : null}
      {review ? (
        <View
          style={{
            gap: 10,
            borderWidth: 1,
            borderColor: colors.border,
            padding: 12,
            borderRadius: 12,
          }}
        >
          <Text style={{ ...text, fontWeight: "700" }}>
            Current rundown · {review.serviceDate}
          </Text>
          {reviewedItem ? (
            <>
              <Text style={text}>Title: {reviewedItem.title}</Text>
              <Text style={text}>
                Type: {reviewedItem.type} · Duration:{" "}
                {durationInput(reviewedItem.duration)}
              </Text>
              <Text style={text}>
                Assignee: {reviewedItem.assignee || "None"}
              </Text>
              <Text style={text}>Cue: {reviewedItem.cue || "None"}</Text>
              <Text style={text}>Notes: {reviewedItem.notes || "None"}</Text>
              <Text style={text}>
                Hard stop: {reviewedItem.hardStop ? "Yes" : "No"}
              </Text>
            </>
          ) : (
            <Text style={text}>
              This item is not in the current rundown.
            </Text>
          )}
          <Text style={text}>
            Order: {review.items.map((i) => i.title).join(" → ") || "No items"}
          </Text>
          <Text style={text}>
            Your draft fields will be kept. The next save uses those fields,
            replacing any current editable values.
          </Text>
          {review.revision !== revision ||
          review.serviceDate !== serviceDate ? (
            <Text accessibilityRole="alert" style={error}>
              The rundown changed again. Review it again before continuing.
            </Text>
          ) : null}
          <AppButton
            label="Keep previous review"
            variant="secondary"
            onPress={() => setReview(null)}
          />
          <AppButton
            label="Use reviewed rundown for item"
            disabled={
              !canEdit ||
              !settled ||
              review.revision !== revision ||
              review.serviceDate !== serviceDate ||
              missing
            }
            onPress={() => {
              state.review();
              setReview(null);
            }}
          />
        </View>
      ) : null}
      {settled ? (
        <AppButton
          label="Discard item draft"
          variant="secondary"
          onPress={() => setDiscarding(true)}
        />
      ) : null}
      {discarding ? (
        <>
          <Text style={text}>
            Discard the retained fields? Accepted edits remain in the rundown.
          </Text>
          <AppButton
            label="Keep item draft"
            variant="secondary"
            onPress={() => setDiscarding(false)}
          />
          <AppButton
            label="Confirm discard item draft"
            variant="danger"
            disabled={!settled}
            onPress={finish}
          />
        </>
      ) : null}
    </View>
  );
}
