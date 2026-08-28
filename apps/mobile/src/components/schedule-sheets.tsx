import { useMemo, useState, type ReactNode } from "react";
import Check from "lucide-react-native/icons/check";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import type { MobileSchedule } from "@/lib/mobile-api";
import { createLocalRequestId } from "@/lib/request-id";
import { getServiceDateForTimeZone, isServiceDate, serviceWallTimeInput } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Service = MobileSchedule["services"][number];
type Assignment = MobileSchedule["assignments"][number];
type Crew = MobileSchedule["crew"][number];

export interface ScheduleServiceDraft {
  requestId: string;
  serviceDate: string;
  name: string;
  startTime: string;
  location: string;
  expectedUpdatedAt?: string;
  inventoryId?: string;
  copyFrom?: string;
  copyFromShowId?: string;
}

export interface ScheduleAssignmentDraft {
  requestId: string;
  showId: string;
  role: string;
  department: string;
  crewMemberId: string | null;
  callTime: string;
  notes: string;
  expectedUpdatedAt?: string;
}

export interface ScheduleTeamDraft {
  showId: string;
  department: string;
  rows: { requestId: string; crewMemberId: string; role: string }[];
}

export interface ScheduleInventoryDraft {
  requestId: string;
  name: string;
  description: string;
  location: string;
  defaultStartTime: string;
  sourceTemplateId: string | null;
}

function ScheduleSheet({ children, onClose, title, eyebrow }: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  eyebrow: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.headerCopy}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.title}>{title}</Text></View>
          <Pressable accessibilityLabel={`Close ${title}`} accessibilityRole="button" onPress={onClose} style={styles.close}><X color={colors.textMuted} size={21} /></Pressable>
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Page>
    </Modal>
  );
}

function runSave(save: () => Promise<void>, setBusy: (value: boolean) => void) {
  setBusy(true);
  void save().catch((error: unknown) => {
    Alert.alert("Schedule not saved", error instanceof Error ? error.message : "Try again.");
  }).finally(() => setBusy(false));
}

export function ScheduleServiceSheet({ initialInventoryId, inventory, onClose, onSave, previousServices, service, timeZone }: {
  initialInventoryId?: string;
  inventory: MobileSchedule["inventory"];
  onClose: () => void;
  onSave: (draft: ScheduleServiceDraft) => Promise<void>;
  previousServices: Service[];
  service: Service | null;
  timeZone: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const initialInventory = inventory.find((item) => item.id === initialInventoryId);
  const [requestId] = useState(() => createLocalRequestId("show"));
  const [serviceDate, setServiceDate] = useState(service?.serviceDate ?? getServiceDateForTimeZone(timeZone));
  const [name, setName] = useState(service?.name ?? initialInventory?.name ?? "");
  const [startTime, setStartTime] = useState(service
    ? serviceWallTimeInput(service.scheduledStartTime, timeZone)
    : initialInventory?.defaultStartTime ?? "");
  const [location, setLocation] = useState(service?.location ?? initialInventory?.location ?? "");
  const [inventoryId, setInventoryId] = useState(initialInventoryId ?? "");
  const [copyFromShowId, setCopyFromShowId] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedPrevious = previousServices.find((candidate) => candidate.id === copyFromShowId);
  const availablePrevious = previousServices.filter((candidate) => candidate.serviceDate < serviceDate);
  const valid = isServiceDate(serviceDate)
    && name.trim().length > 0
    && (!startTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))
    && (!selectedPrevious || selectedPrevious.serviceDate < serviceDate);
  const applyInventory = (id: string) => {
    const item = inventory.find((candidate) => candidate.id === id);
    setInventoryId(id);
    setCopyFromShowId("");
    if (!item) return;
    setName(item.name);
    setLocation(item.location);
    setStartTime(item.defaultStartTime ?? "");
  };
  const applyPrevious = (id: string) => {
    const previous = previousServices.find((candidate) => candidate.id === id);
    setCopyFromShowId(id);
    setInventoryId("");
    if (!previous) return;
    setName(previous.name);
    setLocation(previous.location);
    setStartTime(serviceWallTimeInput(previous.scheduledStartTime, timeZone));
  };
  return (
    <ScheduleSheet eyebrow={service ? "EDIT SHOW" : "NEW SHOW"} onClose={onClose} title={service?.name || "Schedule a show"}>
      <Text style={styles.intro}>{service ? "Changes synchronize to every operator. A newer edit on another device will be protected." : "Create one shared show for web, desktop, and mobile operators."}</Text>
      {!service && (inventory.length > 0 || availablePrevious.length > 0) ? <View style={styles.picker}>
        <Text style={styles.fieldLabel}>STARTING RUNDOWN</Text>
        <Pressable accessibilityRole="radio" accessibilityState={{ checked: !inventoryId && !copyFromShowId }} onPress={() => { setInventoryId(""); setCopyFromShowId(""); }} style={[styles.choice, !inventoryId && !copyFromShowId && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>Start blank</Text><Text style={styles.choiceMeta}>Build a new rundown from scratch</Text></View>{!inventoryId && !copyFromShowId ? <Check color={colors.amberText} size={17} /> : null}</Pressable>
        {inventory.slice(0, 12).map((item) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: inventoryId === item.id }} key={item.id} onPress={() => applyInventory(item.id)} style={[styles.choice, inventoryId === item.id && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{item.name}</Text><Text style={styles.choiceMeta}>Inventory · {item.itemCount} rundown item{item.itemCount === 1 ? "" : "s"}</Text></View>{inventoryId === item.id ? <Check color={colors.amberText} size={17} /> : null}</Pressable>)}
        {availablePrevious.slice(0, 8).map((previous) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: copyFromShowId === previous.id }} key={previous.id} onPress={() => applyPrevious(previous.id)} style={[styles.choice, copyFromShowId === previous.id && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{previous.name || "Untitled show"}</Text><Text style={styles.choiceMeta}>Previous show · {previous.serviceDate} · {previous.itemCount} items</Text></View>{copyFromShowId === previous.id ? <Check color={colors.amberText} size={17} /> : null}</Pressable>)}
      </View> : null}
      {!service ? <AppField autoCapitalize="none" error={serviceDate && !isServiceDate(serviceDate) ? "Use YYYY-MM-DD." : undefined} label="Service date" maxLength={10} onChangeText={setServiceDate} placeholder="2026-09-06" value={serviceDate} /> : null}
      <AppField autoCapitalize="sentences" label="Show or service name" maxLength={120} onChangeText={setName} placeholder="Sunday Morning" value={name} />
      <AppField autoCapitalize="none" error={startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ? "Use 24-hour HH:mm." : undefined} keyboardType="numbers-and-punctuation" label="Start time (optional)" maxLength={5} onChangeText={setStartTime} placeholder="09:30" value={startTime} />
      <AppField autoCapitalize="words" label="Venue or location" maxLength={240} onChangeText={setLocation} placeholder="Main auditorium" value={location} />
      <AppButton disabled={!valid || busy} label={busy ? "Saving show…" : service ? "Save show" : "Create show"} loading={busy} onPress={() => runSave(async () => {
        await onSave({
          requestId,
          serviceDate,
          name: name.trim(),
          startTime,
          location: location.trim(),
          expectedUpdatedAt: service?.updatedAt,
          inventoryId: inventoryId || undefined,
          copyFrom: selectedPrevious?.serviceDate,
          copyFromShowId: selectedPrevious?.id,
        });
        onClose();
      }, setBusy)} />
    </ScheduleSheet>
  );
}

function CrewPicker({ crew, selectedId, onSelect }: { crew: Crew[]; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return crew.filter((person) => !needle || `${person.name} ${person.role} ${person.email}`.toLowerCase().includes(needle)).slice(0, 50);
  }, [crew, search]);
  return <View style={styles.picker}>
    <Text style={styles.fieldLabel}>ROSTER CONTACT</Text>
    <View style={styles.search}><Search color={colors.textFaint} size={15} /><TextInput accessibilityLabel="Search roster" onChangeText={setSearch} placeholder="Search name or role" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={search} /></View>
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selectedId === null }} onPress={() => onSelect(null)} style={[styles.choice, selectedId === null && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>Open position</Text><Text style={styles.choiceMeta}>Nobody assigned yet</Text></View>{selectedId === null ? <Check color={colors.amberText} size={17} /> : null}</Pressable>
    {filtered.map((person) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: selectedId === person.id, disabled: !person.email }} disabled={!person.email} key={person.id} onPress={() => onSelect(person.id)} style={[styles.choice, selectedId === person.id && styles.choiceActive, !person.email && styles.choiceDisabled]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{person.name}</Text><Text style={styles.choiceMeta}>{person.role || "Crew"}{person.email ? ` · ${person.email}` : " · Email required"}</Text></View>{selectedId === person.id ? <Check color={colors.amberText} size={17} /> : null}</Pressable>)}
    {crew.length > 50 && !search ? <Text style={styles.hint}>Search to find more roster contacts.</Text> : null}
  </View>;
}

export function ScheduleAssignmentSheet({ assignment, crew, onClose, onSave, showId }: {
  assignment: Assignment | null;
  crew: Crew[];
  onClose: () => void;
  onSave: (draft: ScheduleAssignmentDraft) => Promise<void>;
  showId: string;
}) {
  const styles = useStyles();
  const [requestId] = useState(() => createLocalRequestId("assignment"));
  const [role, setRole] = useState(assignment?.role ?? "");
  const [department, setDepartment] = useState(assignment?.department ?? "Production");
  const [crewMemberId, setCrewMemberId] = useState<string | null>(assignment?.crewMemberId ?? null);
  const [callTime, setCallTime] = useState(assignment?.callTime ?? "");
  const [notes, setNotes] = useState(assignment?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const personChanged = crewMemberId !== (assignment?.crewMemberId ?? null);
  const valid = role.trim().length > 0 && department.trim().length > 0 && (!callTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(callTime));

  const save = async () => {
    await onSave({ requestId, showId, role: role.trim(), department: department.trim(), crewMemberId, callTime, notes: notes.trim(), expectedUpdatedAt: assignment?.updatedAt });
    onClose();
  };
  const submit = () => {
    if (assignment?.status === "confirmed" && personChanged) {
      Alert.alert("Replace confirmed crew member?", "Their confirmation will be cleared and the new person will receive a fresh invitation.", [
        { text: "Cancel", style: "cancel" },
        { text: "Replace", style: "destructive", onPress: () => runSave(save, setBusy) },
      ]);
      return;
    }
    runSave(save, setBusy);
  };
  return <ScheduleSheet eyebrow={assignment ? "EDIT ASSIGNMENT" : "NEW POSITION"} onClose={onClose} title={assignment?.role || "Add a position"}>
    {assignment ? <View style={styles.responseBox}><Text style={styles.responseLabel}>CURRENT RESPONSE</Text><Text style={styles.responseValue}>{assignment.crewMemberId ? assignment.status : "Open position"}</Text>{assignment.responseNote ? <Text style={styles.responseNote}>{assignment.responseNote}</Text> : null}</View> : null}
    <AppField autoCapitalize="words" label="Position" maxLength={120} onChangeText={setRole} placeholder="Camera Operator" value={role} />
    <AppField autoCapitalize="words" label="Department" maxLength={80} onChangeText={setDepartment} placeholder="Video" value={department} />
    <CrewPicker crew={crew} onSelect={setCrewMemberId} selectedId={crewMemberId} />
    <AppField autoCapitalize="none" error={callTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(callTime) ? "Use 24-hour HH:mm." : undefined} keyboardType="numbers-and-punctuation" label="Custom call time (optional)" maxLength={5} onChangeText={setCallTime} placeholder="08:15" value={callTime} />
    <AppField autoCapitalize="sentences" label="Manager note (optional)" maxLength={500} multiline onChangeText={setNotes} placeholder="Arrival instructions or preparation notes" style={styles.notes} textAlignVertical="top" value={notes} />
    <Text style={styles.hint}>{crewMemberId ? personChanged ? "Saving sends a new secure invitation and resets any earlier response." : "Role and note edits preserve the existing response." : "This remains visible as an open position."}</Text>
    <AppButton disabled={!valid || busy} label={busy ? "Saving assignment…" : assignment ? "Save assignment" : crewMemberId ? "Add and send invitation" : "Add open position"} loading={busy} onPress={submit} />
  </ScheduleSheet>;
}

export function ScheduleTeamSheet({ crew, onClose, onSave, showId }: {
  crew: Crew[];
  onClose: () => void;
  onSave: (draft: ScheduleTeamDraft) => Promise<void>;
  showId: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, { requestId: string; role: string }>>({});
  const [busy, setBusy] = useState(false);
  const visible = crew.filter((person) => person.email && (!search.trim() || `${person.name} ${person.role}`.toLowerCase().includes(search.trim().toLowerCase()))).slice(0, 50);
  const rows = Object.entries(selected).map(([crewMemberId, value]) => ({ crewMemberId, ...value }));
  return <ScheduleSheet eyebrow="TEAM BUILDER" onClose={onClose} title="Build a team">
    <Text style={styles.intro}>Choose several people, confirm each role, then send all invitations together. Safe retries will not duplicate positions.</Text>
    <AppField autoCapitalize="words" label="Team or department" maxLength={80} onChangeText={setDepartment} placeholder="Broadcast" value={department} />
    <View style={styles.search}><Search color={colors.textFaint} size={15} /><TextInput accessibilityLabel="Search roster for team" onChangeText={setSearch} placeholder="Search available roster" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={search} /></View>
    {visible.map((person) => {
      const current = selected[person.id];
      return <View key={person.id} style={[styles.teamPerson, current && styles.choiceActive]}><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: Boolean(current) }} onPress={() => setSelected((values) => {
        if (values[person.id]) { const next = { ...values }; delete next[person.id]; return next; }
        return { ...values, [person.id]: { requestId: createLocalRequestId("assignment"), role: person.role || "Crew" } };
      })} style={styles.teamToggle}><View style={[styles.checkbox, current && styles.checkboxActive]}>{current ? <Check color={colors.black} size={14} /> : null}</View><View style={styles.choiceCopy}><Text style={styles.choiceName}>{person.name}</Text><Text style={styles.choiceMeta}>{person.email}</Text></View></Pressable>{current ? <AppField autoCapitalize="words" label={`Role for ${person.name}`} maxLength={120} onChangeText={(role) => setSelected((values) => ({ ...values, [person.id]: { ...values[person.id]!, role } }))} value={current.role} /> : null}</View>;
    })}
    <AppButton disabled={busy || !department.trim() || rows.length === 0 || rows.some((row) => !row.role.trim())} label={busy ? "Creating team…" : `Create team and send ${rows.length} invitation${rows.length === 1 ? "" : "s"}`} loading={busy} onPress={() => runSave(async () => {
      await onSave({ showId, department: department.trim(), rows: rows.map((row) => ({ ...row, role: row.role.trim() })) });
      onClose();
    }, setBusy)} />
  </ScheduleSheet>;
}

export function ScheduleInventorySheet({ archivedInventory, canManage, inventory, onArchive, onClose, onCreate, onUse, savedTemplates }: {
  archivedInventory: MobileSchedule["archivedInventory"];
  canManage: boolean;
  inventory: MobileSchedule["inventory"];
  onArchive: (item: MobileSchedule["inventory"][number], archived: boolean) => Promise<void>;
  onClose: () => void;
  onCreate: (draft: ScheduleInventoryDraft) => Promise<void>;
  onUse: (inventoryId: string) => void;
  savedTemplates: MobileSchedule["savedTemplates"];
}) {
  const styles = useStyles();
  const [requestId, setRequestId] = useState(() => createLocalRequestId("inventory"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [defaultStartTime, setDefaultStartTime] = useState("");
  const [sourceTemplateId, setSourceTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && (!defaultStartTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(defaultStartTime));
  const create = async () => {
    await onCreate({
      requestId,
      name: name.trim(),
      description: description.trim(),
      location: location.trim(),
      defaultStartTime,
      sourceTemplateId,
    });
    setRequestId(createLocalRequestId("inventory"));
    setName("");
    setDescription("");
    setLocation("");
    setDefaultStartTime("");
    setSourceTemplateId(null);
  };
  return <ScheduleSheet eyebrow="REUSABLE SHOWS" onClose={onClose} title="Show inventory">
    <Text style={styles.intro}>Save a clean show structure once, then load that snapshot into any future date. Scheduled changes never rewrite the inventory.</Text>
    <View style={styles.inventorySection}>
      <Text style={styles.fieldLabel}>AVAILABLE</Text>
      {inventory.length ? inventory.map((item) => <View key={item.id} style={styles.inventoryRow}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{item.name}</Text><Text style={styles.choiceMeta}>{item.itemCount} rundown item{item.itemCount === 1 ? "" : "s"}{item.defaultStartTime ? ` · ${item.defaultStartTime}` : ""}{item.location ? ` · ${item.location}` : ""}</Text>{item.description ? <Text numberOfLines={2} style={styles.hint}>{item.description}</Text> : null}</View>{canManage ? <View style={styles.inventoryActions}><Pressable accessibilityRole="button" onPress={() => onUse(item.id)} style={styles.miniButton}><Text style={styles.miniButtonPrimary}>Use</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={() => runSave(() => onArchive(item, true), setBusy)} style={styles.miniButton}><Text style={styles.miniButtonDanger}>Archive</Text></Pressable></View> : null}</View>) : <Text style={styles.emptyInventory}>No reusable shows yet.</Text>}
    </View>
    {archivedInventory.length ? <View style={styles.inventorySection}><Text style={styles.fieldLabel}>ARCHIVED</Text>{archivedInventory.map((item) => <View key={item.id} style={styles.inventoryRow}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{item.name}</Text><Text style={styles.choiceMeta}>{item.itemCount} rundown items</Text></View>{canManage ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => runSave(() => onArchive(item, false), setBusy)} style={styles.miniButton}><Text style={styles.miniButtonPrimary}>Restore</Text></Pressable> : null}</View>)}</View> : null}
    {canManage ? <View style={styles.inventoryForm}>
      <Text style={styles.fieldLabel}>ADD REUSABLE SHOW</Text>
      <AppField autoCapitalize="words" label="Show name" maxLength={120} onChangeText={setName} placeholder="Sunday Morning" value={name} />
      <AppField autoCapitalize="none" error={defaultStartTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultStartTime) ? "Use 24-hour HH:mm." : undefined} keyboardType="numbers-and-punctuation" label="Default start (optional)" maxLength={5} onChangeText={setDefaultStartTime} placeholder="10:00" value={defaultStartTime} />
      <AppField autoCapitalize="words" label="Location (optional)" maxLength={240} onChangeText={setLocation} placeholder="Main room" value={location} />
      {savedTemplates.length ? <View style={styles.picker}><Text style={styles.fieldLabel}>RUNDOWN SOURCE</Text><Pressable accessibilityRole="radio" accessibilityState={{ checked: sourceTemplateId === null }} onPress={() => setSourceTemplateId(null)} style={[styles.choice, sourceTemplateId === null && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>Empty rundown</Text><Text style={styles.choiceMeta}>Add items after scheduling</Text></View></Pressable>{savedTemplates.map((template) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: sourceTemplateId === template.id }} key={template.id} onPress={() => setSourceTemplateId(template.id)} style={[styles.choice, sourceTemplateId === template.id && styles.choiceActive]}><View style={styles.choiceCopy}><Text style={styles.choiceName}>{template.name}</Text><Text style={styles.choiceMeta}>{template.itemCount} saved item{template.itemCount === 1 ? "" : "s"}</Text></View></Pressable>)}</View> : null}
      <AppField autoCapitalize="sentences" label="Description (optional)" maxLength={500} multiline onChangeText={setDescription} placeholder="When this reusable show should be used" style={styles.notes} textAlignVertical="top" value={description} />
      <AppButton disabled={!valid || busy} label={busy ? "Saving reusable show…" : "Add to inventory"} loading={busy} onPress={() => runSave(create, setBusy)} />
    </View> : null}
  </ScheduleSheet>;
}

export function ScheduleProviderSheet({ current, onClose, onSave, terminologyProfile }: {
  current: MobileSchedule["provider"];
  onClose: () => void;
  onSave: (input: MobileSchedule["provider"] & { terminologyProfile: MobileSchedule["terminologyProfile"] }) => Promise<void>;
  terminologyProfile: MobileSchedule["terminologyProfile"];
}) {
  const styles = useStyles();
  const [provider, setProvider] = useState(current.type);
  const [url, setUrl] = useState(current.url);
  const [label, setLabel] = useState(current.label);
  const [terms, setTerms] = useState(terminologyProfile);
  const [busy, setBusy] = useState(false);
  const providers = [
    ["native", "ShowPilot native"], ["planning-center", "Planning Center"], ["faithteams", "Faith Teams"], ["other", "Other platform"],
  ] as const;
  return <ScheduleSheet eyebrow="SCHEDULING SOURCE" onClose={onClose} title="Schedule settings">
    <Text style={styles.fieldLabel}>SOURCE</Text>
    <View style={styles.options}>{providers.map(([value, title]) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: provider === value }} key={value} onPress={() => setProvider(value)} style={[styles.option, provider === value && styles.optionActive]}><Text style={[styles.optionText, provider === value && styles.optionTextActive]}>{title}</Text></Pressable>)}</View>
    <Text style={styles.fieldLabel}>ORGANIZATION LANGUAGE</Text>
    <View style={styles.options}><Pressable accessibilityRole="radio" accessibilityState={{ checked: terms === "general" }} onPress={() => setTerms("general")} style={[styles.option, terms === "general" && styles.optionActive]}><Text style={[styles.optionText, terms === "general" && styles.optionTextActive]}>Shows and assignments</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ checked: terms === "church" }} onPress={() => setTerms("church")} style={[styles.option, terms === "church" && styles.optionActive]}><Text style={[styles.optionText, terms === "church" && styles.optionTextActive]}>Services and serving</Text></Pressable></View>
    {provider !== "native" ? <><AppField autoCapitalize="words" label="Platform name" maxLength={80} onChangeText={setLabel} placeholder="My scheduling platform" value={label} /><AppField autoCapitalize="none" autoCorrect={false} keyboardType="url" label="Scheduling workspace URL" maxLength={500} onChangeText={setUrl} placeholder="https://…" value={url} /></> : null}
    <AppButton disabled={busy || (provider !== "native" && !url.trim())} label={busy ? "Saving settings…" : "Save schedule settings"} loading={busy} onPress={() => runSave(async () => {
      await onSave({ type: provider, url: provider === "native" ? "" : url.trim(), label: provider === "native" ? "" : label.trim(), terminologyProfile: terms });
      onClose();
    }, setBusy)} />
  </ScheduleSheet>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerCopy: { flex: 1, gap: 4 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  title: { color: colors.text, fontFamily, fontSize: 21, fontWeight: "900" },
  close: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.medium, paddingBottom: 40 },
  intro: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 19 },
  picker: { gap: 7 },
  fieldLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  search: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 13 },
  choice: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 11 },
  choiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  choiceDisabled: { opacity: 0.45 },
  choiceCopy: { flex: 1, minWidth: 0, gap: 3 },
  choiceName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  choiceMeta: { color: colors.textMuted, fontFamily, fontSize: 11 },
  hint: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16 },
  notes: { minHeight: 92, paddingTop: 13 },
  responseBox: { gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  responseLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  responseValue: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "800", textTransform: "capitalize" },
  responseNote: { color: colors.text, fontFamily, fontSize: 11, lineHeight: 17 },
  teamPerson: { gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 10 },
  teamToggle: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border },
  checkboxActive: { borderColor: colors.amber, backgroundColor: colors.amber },
  inventorySection: { gap: 8 },
  inventoryRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 11 },
  inventoryActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 5 },
  miniButton: { minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10 },
  miniButtonPrimary: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900" },
  miniButtonDanger: { color: colors.red, fontFamily, fontSize: 11, fontWeight: "900" },
  emptyInventory: { color: colors.textFaint, fontFamily, fontSize: 11, textAlign: "center", borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: 18 },
  inventoryForm: { gap: spacing.medium, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.medium },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  option: { minHeight: 42, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13 },
  optionActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  optionText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  optionTextActive: { color: colors.amberText },
}));
