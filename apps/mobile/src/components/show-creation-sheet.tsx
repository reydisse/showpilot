import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import X from "lucide-react-native/icons/x";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useShowCreation } from "@/hooks/use-show-creation";
import {
  commandMobileShowCreation,
  type MobileSchedule,
} from "@/lib/mobile-api";
import {
  creationCommand,
  type ShowCreationDraft,
  type ShowCreationSource,
} from "@/lib/show-creation-recovery";
import { isServiceDate, serviceWallTimeInput } from "@/lib/service-time";
import {
  createThemedStyles,
  fontFamily,
  spacing,
  useAppTheme,
} from "@/theme/tokens";

export function ShowCreationSheet(props: {
  orgId: string;
  userId: string;
  initial: ShowCreationDraft;
  onClose: () => void;
  inventory?: MobileSchedule["inventory"];
  shows?: {
    id: string;
    serviceDate: string;
    name: string;
    scheduledStartTime: string | null;
    scheduledCallTime?: string | null;
    location: string;
  }[];
}) {
  const { colors } = useAppTheme(),
    styles = useStyles();
  const client = useQueryClient(),
    active = useScreenFocus();
  const [discarding, setDiscarding] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const state = useShowCreation(props, props.initial, {
    active,
    send: commandMobileShowCreation,
    refresh: async (signal) => {
      await Promise.all([
        client.invalidateQueries(
          { queryKey: ["mobile-schedule", props.orgId] },
          { throwOnError: true },
        ),
        client.invalidateQueries(
          { queryKey: ["mobile-bootstrap", props.userId, props.orgId] },
          { throwOnError: true },
        ),
      ]);
      if (signal.aborted) throw new Error("Show refresh cancelled.");
    },
  });
  const { draft, attempt, locked } = state;
  const editable = active && !locked;
  const valid = creationCommand(props, "validation", draft).success;
  const source = draft.source;
  const sourceMissing =
    source.kind === "inventory"
      ? props.inventory !== undefined &&
        !props.inventory.some((item) => item.id === source.id)
      : source.kind === "show"
        ? props.shows !== undefined &&
          !props.shows.some((show) => show.id === source.id)
        : false;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  function field(
    name: "name" | "serviceDate" | "startTime" | "callTime" | "location",
    value: string,
  ) {
    state.setDraft((current) => ({ ...current, [name]: value }));
  }
  function select(
    source: ShowCreationSource,
    defaults: Partial<ShowCreationDraft> = {},
  ) {
    state.setDraft((current) => ({ ...current, ...defaults, source }));
  }
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible
    >
      <Page scroll={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Create show</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close create show"
            onPress={props.onClose}
            style={styles.close}
          >
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <Text style={styles.copy}>
            You can close this form and resume it from Shows, Schedule, or a
            rundown. Drafts are kept for this signed-in app session.
          </Text>
          <Text style={styles.copy}>Times use {draft.timeZone}.</Text>
          <AppField
            label="Show name"
            error={!draft.name.trim() ? "Enter a show name." : undefined}
            maxLength={120}
            value={draft.name}
            editable={editable}
            onChangeText={(value) => field("name", value)}
          />
          <AppField
            label="Show date"
            maxLength={10}
            value={draft.serviceDate}
            editable={editable}
            onChangeText={(value) => field("serviceDate", value)}
            error={
              !isServiceDate(draft.serviceDate)
                ? "Use a real YYYY-MM-DD date."
                : undefined
            }
          />
          <AppField
            label="Start time (optional)"
            maxLength={5}
            value={draft.startTime}
            editable={editable}
            onChangeText={(value) => field("startTime", value)}
            error={
              draft.startTime &&
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.startTime)
                ? "Use 24-hour HH:mm."
                : undefined
            }
          />
          <AppField
            label="Crew call (optional)"
            maxLength={5}
            value={draft.callTime}
            editable={editable}
            onChangeText={(value) => field("callTime", value)}
            error={
              draft.callTime &&
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.callTime)
                ? "Use 24-hour HH:mm."
                : undefined
            }
          />
          <AppField
            label="Venue or location"
            maxLength={240}
            value={draft.location}
            editable={editable}
            onChangeText={(value) => field("location", value)}
          />
          <Text style={styles.label}>Starting rundown</Text>
          <Text style={styles.copy}>
            {source.kind === "blank"
              ? "Start blank"
              : `${source.kind === "inventory" ? "Inventory" : "Show"}: ${source.name}${source.kind === "show" ? ` (${source.serviceDate})` : ""}`}
          </Text>
          {sourceMissing ? (
            <Text style={styles.error}>
              This source is not in the current list. Your selection is retained
              and will be checked when creating the show.
            </Text>
          ) : null}
          <AppButton
            label="Start blank"
            variant="secondary"
            disabled={!editable}
            onPress={() => select({ kind: "blank" })}
          />
          {(props.inventory ?? []).map((item) => (
            <AppButton
              key={item.id}
              variant="secondary"
              label={`Use inventory: ${item.name}`}
              disabled={!editable}
              onPress={() =>
                select(
                  { kind: "inventory", id: item.id, name: item.name },
                  {
                    name: item.name,
                    startTime: item.defaultStartTime ?? "",
                    location: item.location ?? "",
                    callTime: "",
                  },
                )
              }
            />
          ))}
          {(props.shows ?? [])
            .filter((show) => show.serviceDate <= draft.serviceDate)
            .map((show) => (
              <AppButton
                key={show.id}
                variant="secondary"
                label={`Copy rundown: ${show.name || "Untitled show"} (${show.serviceDate})`}
                disabled={!editable}
                onPress={() =>
                  select(
                    {
                      kind: "show",
                      id: show.id,
                      name: show.name || "Untitled show",
                      serviceDate: show.serviceDate,
                    },
                    {
                      name: show.name,
                      startTime: serviceWallTimeInput(
                        show.scheduledStartTime,
                        draft.timeZone,
                      ),
                      location: show.location,
                      callTime: serviceWallTimeInput(
                        show.scheduledCallTime ?? null,
                        draft.timeZone,
                      ),
                    },
                  )
                }
              />
            ))}
          {attempt ? (
            <View accessibilityLiveRegion="polite" style={styles.progress}>
              <Text style={styles.label}>{attempt.label}</Text>
              {attempt.kind === "pending" ? (
                <Text style={styles.copy}>
                  Confirming the original creation request… You can close and
                  resume this form.
                </Text>
              ) : null}
              {attempt.kind === "failed" ? (
                <>
                  <Text style={styles.error}>{attempt.message}</Text>
                  <AppButton
                    label="Retry original creation"
                    onPress={state.retry}
                  />
                  <Text style={styles.copy}>
                    Review finds the original show or cancels an unapplied
                    request, so a delayed request cannot create it later.
                  </Text>
                  <AppButton
                    variant="secondary"
                    label="Review original creation"
                    onPress={state.reviewOriginal}
                  />
                </>
              ) : null}
              {attempt.kind === "confirmed" ? (
                <>
                  <Text style={styles.copy}>
                    {attempt.result.result.kind === "created"
                      ? "Show created. Creating it again is disabled."
                      : attempt.result.result.kind === "cancelled"
                        ? "The original request was cancelled before creation. You can safely edit this draft."
                        : "The original show was created and later removed. This request will not recreate it."}
                  </Text>
                  {attempt.refresh === "pending" ? (
                    <Text style={styles.copy}>Refreshing shows…</Text>
                  ) : null}
                  {attempt.refresh === "failed" ||
                  attempt.refresh === "idle" ? (
                    <>
                      <Text style={styles.error}>
                        {attempt.message ?? "Refresh the show list to finish."}{" "}
                        The creation outcome above is confirmed.
                      </Text>
                      <AppButton label="Refresh only" onPress={state.refresh} />
                    </>
                  ) : null}
                  {settled ? (
                    <>
                      {attempt.result.result.kind === "created" ? (
                        <AppButton
                          label="Open created show"
                          onPress={() => {
                            if (attempt.result.result.kind !== "created")
                              return;
                            try {
                              router.push({
                                pathname: "/show/[showId]",
                                params: {
                                  showId: attempt.result.result.result.showId,
                                },
                              });
                              if (state.finish()) props.onClose();
                            } catch (error) {
                              setNavigationError(
                                error instanceof Error
                                  ? error.message
                                  : "Could not open the show. Try again.",
                              );
                            }
                          }}
                        />
                      ) : null}
                      {attempt.result.result.kind === "cancelled" ? (
                        <AppButton
                          label="Edit unapplied draft"
                          onPress={state.editUnapplied}
                        />
                      ) : null}
                      <AppButton
                        variant="secondary"
                        label="Finish"
                        onPress={() => {
                          if (state.finish()) props.onClose();
                        }}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : (
            <>
              <AppButton
                label="Create show"
                disabled={!editable || !valid}
                onPress={state.submit}
              />
              {discarding ? (
                <>
                  <Text style={styles.copy}>
                    Discard this unsent show draft?
                  </Text>
                  <AppButton
                    variant="danger"
                    label="Discard draft"
                    onPress={() => {
                      if (state.discard()) props.onClose();
                    }}
                  />
                  <AppButton
                    variant="secondary"
                    label="Keep draft"
                    onPress={() => setDiscarding(false)}
                  />
                </>
              ) : (
                <AppButton
                  variant="secondary"
                  label="Discard…"
                  onPress={() => setDiscarding(true)}
                />
              )}
            </>
          )}
          {navigationError ? (
            <Text style={styles.error}>{navigationError}</Text>
          ) : null}
        </ScrollView>
      </Page>
    </Modal>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    header: { flexDirection: "row", alignItems: "center", gap: spacing.medium },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily,
      fontSize: 22,
      fontWeight: "800",
    },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      width: "100%",
      maxWidth: 620,
      alignSelf: "center",
      gap: spacing.medium,
      paddingVertical: spacing.large,
      paddingBottom: 60,
    },
    copy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
    label: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
    error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
    progress: { gap: spacing.medium },
  }),
);
