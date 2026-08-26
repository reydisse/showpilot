import { useCallback, useEffect, useRef, useState } from "react";
import Building2 from "lucide-react-native/icons/building-2";
import Check from "lucide-react-native/icons/check";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import MailCheck from "lucide-react-native/icons/mail-check";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function normalizeWorkspaceSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function validWorkspaceSlug(value: string): boolean {
  return value.length >= 3 && value.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export default function OrganizationsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: session, isPending: sessionPending, refetch: refetchSession } = authClient.useSession();
  const { data: organizations, isPending, isRefetching, error: organizationsError, refetch: refetchOrganizations } = authClient.useListOrganizations();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [verificationChecked, setVerificationChecked] = useState(false);
  const [refreshingVerification, setRefreshingVerification] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const autoSelectionAttempted = useRef(false);

  async function resendVerification() {
    if (!session?.user.email) return;
    setSelectionError("");
    setVerificationChecked(false);
    setSendingVerification(true);
    try {
      const result = await authClient.sendVerificationEmail({
        email: session.user.email,
        callbackURL: "/verify-email",
      });
      if (result.error) throw new Error(result.error.message || "Verification email could not be sent.");
      setVerificationSent(true);
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "Verification email could not be sent.");
    } finally {
      setSendingVerification(false);
    }
  }

  async function refreshVerification() {
    setSelectionError("");
    setRefreshingVerification(true);
    try {
      await refetchSession();
      await refetchOrganizations();
      setVerificationChecked(true);
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "Your account could not be refreshed.");
    } finally {
      setRefreshingVerification(false);
    }
  }

  async function createWorkspace() {
    const name = workspaceName.trim();
    const slug = normalizeWorkspaceSlug(workspaceSlug);
    if (!name || !validWorkspaceSlug(slug) || creatingWorkspace) return;
    setSelectionError("");
    setCreatingWorkspace(true);
    try {
      const created = await authClient.organization.create({ name, slug });
      if (created.error || !created.data) {
        throw new Error(created.error?.message || "The workspace could not be created.");
      }
      const active = await authClient.organization.setActive({ organizationId: created.data.id });
      if (active.error) {
        await refetchOrganizations();
        throw new Error(active.error.message || "The workspace was created but could not be opened. Select it above to continue.");
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(app)");
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "The workspace could not be created.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreatingWorkspace(false);
    }
  }

  async function useAnotherAccount() {
    setSelectionError("");
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Sign out could not be completed.");
      router.replace("/sign-in");
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "Sign out could not be completed.");
    } finally {
      setSigningOut(false);
    }
  }

  const chooseOrganization = useCallback(async (organizationId: string) => {
    if (choosingId) return;
    setSelectionError("");
    setChoosingId(organizationId);
    try {
      const result = await authClient.organization.setActive({ organizationId });
      if (result.error) throw new Error(result.error.message || "The workspace could not be opened.");
      await Haptics.selectionAsync();
      router.replace("/(app)");
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "ShowPilot could not be reached. Check your connection and try again.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setChoosingId(null);
    }
  }, [choosingId]);

  useEffect(() => {
    if (organizations?.length === 1 && !activeOrganization && !autoSelectionAttempted.current) {
      autoSelectionAttempted.current = true;
      void chooseOrganization(organizations[0].id);
    }
  }, [activeOrganization, chooseOrganization, organizations]);

  if (sessionPending || isPending) return <LoadingView label="Loading your workspaces…" />;
  if (!session) return <Redirect href="/sign-in" />;

  const hasOrganizations = Boolean(organizations?.length);
  const noOrganizations = organizations?.length === 0;
  const emailVerified = session.user.emailVerified === true;
  const canCreateWorkspace = Boolean(workspaceName.trim()) && validWorkspaceSlug(workspaceSlug);
  const pageTitle = hasOrganizations ? "Choose your team" : emailVerified ? "Create your workspace" : "Verify your account";

  return (
    <Page eyebrow="WORKSPACE" title={pageTitle} refreshing={isRefetching || refreshingVerification} onRefresh={refreshVerification}>
      <Text style={styles.intro}>Your shows, crew, and permissions stay isolated inside each organization.</Text>
      {selectionError ? <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text> : null}
      {organizationsError ? <Text accessibilityRole="alert" onPress={refreshVerification} style={styles.error}>{organizationsError.message || "Your workspaces could not be loaded."} · Tap to retry</Text> : null}
      <View style={styles.list}>
        {organizations?.map((organization) => {
          const active = organization.id === activeOrganization?.id;
          const choosing = choosingId === organization.id;
          return (
            <Pressable accessibilityRole="button" accessibilityState={{ busy: choosing, disabled: Boolean(choosingId) }} disabled={Boolean(choosingId)} key={organization.id} onPress={() => chooseOrganization(organization.id)} style={({ pressed }) => [styles.card, active && styles.cardActive, pressed && styles.pressed, choosingId && !choosing && styles.disabled]}>
              <View style={[styles.icon, active && styles.iconActive]}><Building2 size={22} color={active ? colors.black : colors.amberText} /></View>
              <View style={styles.cardCopy}>
                <Text style={styles.name}>{organization.name}</Text>
                <Text style={styles.slug}>{organization.slug}</Text>
              </View>
              {choosing ? <ActivityIndicator color={colors.amberText} /> : active ? <Check size={20} color={colors.amberText} /> : <ChevronRight size={20} color={colors.textFaint} />}
            </Pressable>
          );
        })}
      </View>
      {noOrganizations && !emailVerified ? (
        <View style={styles.onboardingCard}>
          <View style={styles.onboardingIcon}><MailCheck size={24} color={colors.amberText} /></View>
          <Text style={styles.emptyTitle}>Verify your email</Text>
          <Text style={styles.emptyCopy}>We sent a verification link to {session.user.email}. Open it, then return here to continue.</Text>
          {verificationSent ? <Text style={styles.success}>Verification email sent. Check your inbox and spam folder.</Text> : null}
          {verificationChecked ? <Text style={styles.checkHint}>This account is not verified yet. Open the newest email link, then refresh again.</Text> : null}
          <AppButton label={verificationSent ? "Verification email sent" : "Resend verification email"} loading={sendingVerification} disabled={verificationSent} variant="secondary" onPress={resendVerification} />
          <AppButton label="I verified my email" loading={refreshingVerification} onPress={refreshVerification} />
          <AppButton label="Use another account" loading={signingOut} variant="secondary" onPress={useAnotherAccount} />
        </View>
      ) : null}
      {noOrganizations && emailVerified ? (
        <View style={styles.onboardingCard}>
          <View style={styles.onboardingIcon}><Plus size={24} color={colors.amberText} /></View>
          <Text style={styles.emptyTitle}>Create your first workspace</Text>
          <Text style={styles.emptyCopy}>Workspaces keep each organization’s shows, crew, devices, and permissions separate.</Text>
          <AppField
            label="Workspace name"
            value={workspaceName}
            onChangeText={(value) => {
              setWorkspaceName(value);
              if (!slugEdited) setWorkspaceSlug(normalizeWorkspaceSlug(value));
            }}
            autoCapitalize="words"
            maxLength={120}
            placeholder="Faithfire Church"
          />
          <AppField
            label="Workspace URL"
            value={workspaceSlug}
            onChangeText={(value) => {
              setSlugEdited(true);
              setWorkspaceSlug(normalizeWorkspaceSlug(value));
            }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
            placeholder="faithfire-church"
            error={workspaceSlug.length > 0 && !validWorkspaceSlug(workspaceSlug) ? "Use 3–40 letters, numbers, or hyphens; begin and end with a letter or number." : undefined}
          />
          {workspaceSlug ? <Text style={styles.urlPreview}>showpilot.tech/{workspaceSlug}</Text> : null}
          <AppButton label="Create workspace" loading={creatingWorkspace} disabled={!canCreateWorkspace} onPress={createWorkspace} />
          <View style={styles.refreshHint}><RefreshCw size={13} color={colors.textFaint} /><Text style={styles.refreshHintText}>Already invited? Pull down or reopen this page after accepting your invitation.</Text></View>
          <AppButton label="Use another account" loading={signingOut} variant="secondary" onPress={useAnotherAccount} />
        </View>
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 15, lineHeight: 22, marginTop: -12 },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 19, borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft, padding: 12 },
  list: { gap: 12 },
  card: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 14, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  cardActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  icon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.amberSoft },
  iconActive: { backgroundColor: colors.amber },
  cardCopy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  slug: { color: colors.textFaint, fontFamily, fontSize: 12 },
  onboardingCard: { gap: 13, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  onboardingIcon: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amberSoft },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  emptyCopy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
  success: { color: colors.green, fontFamily, fontSize: 13, lineHeight: 19 },
  checkHint: { color: colors.amberText, fontFamily, fontSize: 13, lineHeight: 19 },
  urlPreview: { color: colors.amberText, fontFamily, fontSize: 12 },
  refreshHint: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  refreshHintText: { flex: 1, color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 17 },
}));
