import React, { useEffect, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert,
  ActivityIndicator, TextInput, Modal,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { formatDate } from "@/lib/format";
import { buildHtmlDocument, runReportExport, escapeHtml } from "@/lib/export-utils";
import { EmptyState } from "@/components/EmptyState";
import { authedJson as apiJson } from "@/lib/authed-fetch";
import { isSessionExpired } from "@/lib/session";
import { useData } from "@/lib/data-context";
import { ScreenHeader } from "@/components/ScreenHeader";

type Condition = "good" | "damaged" | "partial";
type DeliveryStatus = "received" | "checked" | "accepted" | "rejected";

type LineItem = { description: string; quantity: string; unit: string; condition: Condition };

type Delivery = {
  id: string;
  siteId: string;
  date: string;
  time?: string;
  docketNumber?: string;
  supplier: string;
  supplierContact?: string;
  purchaseOrder?: string;
  vehicleReg?: string;
  driverName?: string;
  items: string[];
  quantity: string;
  notes: string;
  receivedBy?: string;
  conditionOnArrival?: Condition;
  damageDescription?: string;
  storageLocation?: string;
  nonConformances?: string;
  deliveryStatus?: DeliveryStatus;
};

const CONDITION_META: Record<Condition, { label: string; color: string }> = {
  good:    { label: "Good",    color: Colors.success },
  damaged: { label: "Damaged", color: Colors.error },
  partial: { label: "Partial", color: Colors.accentLight },
};

const STATUS_META: Record<DeliveryStatus, { label: string; color: string }> = {
  received: { label: "Received",  color: Colors.infoBorder },
  checked:  { label: "Checked",  color: Colors.accentLight },
  accepted: { label: "Accepted", color: Colors.success },
  rejected: { label: "Rejected", color: Colors.error },
};

/** Single-delivery docket (proof of delivery). */
function buildDeliveryHtml(d: Delivery, siteName: string, client: string): string {
  const rows: Array<[string, string]> = [];
  const push = (label: string, value?: string | null) => {
    if (value && value.trim()) rows.push([label, value.trim()]);
  };
  push("Supplier Contact", d.supplierContact);
  push("Purchase Order", d.purchaseOrder);
  push("Driver", [d.driverName, d.vehicleReg].filter(Boolean).join(" · "));
  push("Received By", d.receivedBy);
  if (d.conditionOnArrival) push("Condition on Arrival", CONDITION_META[d.conditionOnArrival].label);
  push("Quantity", d.quantity);
  push("Storage Location", d.storageLocation);
  push("Damage", d.damageDescription);
  push("Non-Conformances", d.nonConformances);
  push("Notes", d.notes);

  const detailRows = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  const itemsList = d.items.filter(Boolean).map((it) => `<li>${escapeHtml(it)}</li>`).join("");

  return buildHtmlDocument({
    eyebrow: "Delivery Docket",
    title: d.supplier?.trim() || (d.docketNumber ? `Docket #${d.docketNumber}` : "Delivery"),
    subtitle: `${siteName}${client ? ` · ${client}` : ""} · ${formatDate(d.date)}${d.time ? ` · ${d.time}` : ""}`,
    meta: [
      { label: "Date", value: `${formatDate(d.date)}${d.time ? ` · ${d.time}` : ""}` },
      { label: "Docket #", value: d.docketNumber || "—" },
      { label: "Supplier", value: d.supplier?.trim() || "—" },
      { label: "Status", value: d.deliveryStatus ? STATUS_META[d.deliveryStatus].label : "—" },
    ],
    body: `
      ${itemsList ? `<section class="section"><h2>Items</h2><ul class="checklist">${itemsList}</ul></section>` : ""}
      ${detailRows ? `<section class="section"><h2>Details</h2><table class="detail-table">${detailRows}</table></section>` : ""}
    `,
  });
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <View style={formStyles.field}>
      <Text style={formStyles.label}>{label}{required ? <Text style={formStyles.required}> *</Text> : null}</Text>
      {children}
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={formStyles.sectionHeader}>{title}</Text>;
}

function ChipGroup<T extends string>({
  options, value, onChange, meta,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  meta: Record<string, { label: string; color: string }>;
}) {
  return (
    <View style={formStyles.chipRow}>
      {options.map((opt) => {
        const active = value === opt;
        const { label, color } = meta[opt] ?? { label: opt, color: Colors.accent };
        return (
          <Pressable
            key={opt}
            style={[formStyles.chip, active && { backgroundColor: color, borderColor: color }]}
            onPress={() => onChange(opt)}
          >
            <Text style={[formStyles.chipText, active && formStyles.chipTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function LineItemRow({
  item, index, onChange, onRemove,
}: {
  item: LineItem;
  index: number;
  onChange: (field: keyof LineItem, value: string) => void;
  onRemove: () => void;
}) {
  const conditions: Condition[] = ["good", "damaged", "partial"];
  return (
    <View style={formStyles.lineItemCard}>
      <View style={formStyles.lineItemHeader}>
        <Text style={formStyles.lineItemIndex}>Item {index + 1}</Text>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Ionicons name="close-circle" size={20} color={Colors.error} />
        </Pressable>
      </View>
      <TextInput
        style={formStyles.input}
        value={item.description}
        onChangeText={(v) => onChange("description", v)}
        placeholder="Material / item description *"
        placeholderTextColor={Colors.textTertiary}
      />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <TextInput
            style={formStyles.input}
            value={item.quantity}
            onChangeText={(v) => onChange("quantity", v)}
            placeholder="Qty (e.g. 20)"
            placeholderTextColor={Colors.textTertiary}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={{ flex: 1 }}>
          <TextInput
            style={formStyles.input}
            value={item.unit}
            onChangeText={(v) => onChange("unit", v)}
            placeholder="Unit (bag, m³, each)"
            placeholderTextColor={Colors.textTertiary}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {conditions.map((c) => (
          <Pressable
            key={c}
            style={[formStyles.miniChip, item.condition === c && { backgroundColor: CONDITION_META[c].color, borderColor: CONDITION_META[c].color }]}
            onPress={() => onChange("condition", c)}
          >
            <Text style={[formStyles.miniChipText, item.condition === c && { color: Colors.white }]}>{CONDITION_META[c].label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function DeliveriesScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const { getSite } = useData();
  const site = getSite(siteId);
  const insets = useSafeAreaInsets();

  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state
  const [docketNumber, setDocketNumber] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [time, setTime] = useState(new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }));
  const [supplier, setSupplier] = useState("");
  const [supplierContact, setSupplierContact] = useState("");
  const [purchaseOrder, setPurchaseOrder] = useState("");
  const [vehicleReg, setVehicleReg] = useState("");
  const [driverName, setDriverName] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([{ description: "", quantity: "", unit: "", condition: "good" }]);
  const [receivedBy, setReceivedBy] = useState("");
  const [conditionOnArrival, setConditionOnArrival] = useState<Condition>("good");
  const [damageDescription, setDamageDescription] = useState("");
  const [storageLocation, setStorageLocation] = useState("");
  const [nonConformances, setNonConformances] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus>("received");
  const [notes, setNotes] = useState("");

  const load = async () => {
    try {
      const data = await apiJson<{ deliveries: Delivery[] }>(`/api/deliveries?siteId=${siteId}`);
      setDeliveries(data.deliveries);
    } catch {
      // silent in dev
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [siteId]);

  const resetForm = () => {
    setDocketNumber(""); setDate(new Date().toISOString().split("T")[0]);
    setTime(new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }));
    setSupplier(""); setSupplierContact(""); setPurchaseOrder("");
    setVehicleReg(""); setDriverName("");
    setLineItems([{ description: "", quantity: "", unit: "", condition: "good" }]);
    setReceivedBy(""); setConditionOnArrival("good"); setDamageDescription("");
    setStorageLocation(""); setNonConformances(""); setDeliveryStatus("received"); setNotes("");
  };

  const updateLineItem = (index: number, field: keyof LineItem, value: string) => {
    setLineItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  };

  const addLineItem = () => {
    setLineItems((prev) => [...prev, { description: "", quantity: "", unit: "", condition: "good" }]);
  };

  const removeLineItem = (index: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAdd = async () => {
    const validItems = lineItems.filter((li) => li.description.trim());
    if (!supplier.trim() && validItems.length === 0) {
      Alert.alert("Required", "Please enter at least a supplier name or one material item.");
      return;
    }
    setSaving(true);
    try {
      await apiJson(`/api/deliveries`, {
        method: "POST",
        body: JSON.stringify({
          siteId,
          date,
          supplier: supplier.trim(),
          items: validItems.map((li) => `${li.description.trim()} — ${li.quantity} ${li.unit} (${CONDITION_META[li.condition].label})`),
          quantity: validItems.map((li) => `${li.quantity} ${li.unit}`).filter(Boolean).join(", "),
          notes: notes.trim(),
          time, docketNumber: docketNumber.trim(), supplierContact: supplierContact.trim(),
          purchaseOrder: purchaseOrder.trim(), vehicleReg: vehicleReg.trim(),
          driverName: driverName.trim(), receivedBy: receivedBy.trim(),
          conditionOnArrival, damageDescription: damageDescription.trim(),
          storageLocation: storageLocation.trim(), nonConformances: nonConformances.trim(),
          deliveryStatus,
        }),
      });
      setShowForm(false);
      resetForm();
      await load();
    } catch (err) {
      // A dead session is reported once, centrally, and the app is already
      // on its way to the sign-in screen. This feature must not also blame
      // itself for it - that substitution is the defect.
      if (isSessionExpired(err)) return;
      Alert.alert("Error", "Failed to save delivery record. Please check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const handleExportDelivery = (d: Delivery) => {
    if (!site) return;
    const html = buildDeliveryHtml(d, site.name, site.client);
    const base = `sitesnap-docket-${d.date}-${d.id}`;
    Alert.alert("Export Delivery Docket", "Choose a format.", [
      { text: "Cancel", style: "cancel" },
      { text: "Word", onPress: () => void runReportExport({ filenameBase: base, html, format: "doc", label: "the delivery docket" }) },
      { text: "PDF", onPress: () => void runReportExport({ filenameBase: base, html, format: "pdf", label: "the delivery docket" }) },
    ]);
  };

  const handleDelete = (id: string) => {
    Alert.alert("Delete Delivery", "Remove this delivery record?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await apiJson(`/api/deliveries/${id}`, { method: "DELETE" }).catch(() => {});
          setDeliveries((prev) => prev.filter((d) => d.id !== id));
        },
      },
    ]);
  };

  const conditions: Condition[] = ["good", "damaged", "partial"];
  const statuses: DeliveryStatus[] = ["received", "checked", "accepted", "rejected"];

  return (
    <View style={styles.container}>
      <ScreenHeader
        variant="navy"
        title="Material Dockets"
        subtitle={site?.name}
        paddingBottom={18}
        paddingTopExtra={16}
        backButtonStyle={styles.backBtn}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSub}
        right={
          <Pressable onPress={() => setShowForm(true)} style={styles.addBtn}>
            <Ionicons name="add" size={22} color={Colors.white} />
            <Text style={styles.addBtnText}>Log</Text>
          </Pressable>
        }
      />

      {deliveries.length > 0 && (
        <View style={styles.summaryBar}>
          <Ionicons name="cube-outline" size={16} color={Colors.primary} />
          <Text style={styles.summaryText}>{deliveries.length} delivery record{deliveries.length !== 1 ? "s" : ""}</Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : deliveries.length === 0 ? (
        <EmptyState
          icon="cube-outline"
          title="No deliveries recorded"
          subtitle="Log material deliveries to maintain a full delivery register and docket trail."
          ctaLabel="Log Delivery"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {deliveries.map((d) => {
            const cond = d.conditionOnArrival ? CONDITION_META[d.conditionOnArrival] : null;
            const status = d.deliveryStatus ? STATUS_META[d.deliveryStatus] : null;
            const expanded = expandedId === d.id;
            // Card title: supplier if present, else fall back to the docket number,
            // else the date — never a broken-looking "Unknown Supplier" placeholder.
            const supplierName = d.supplier?.trim();
            const usedDocketAsTitle = !supplierName && !!d.docketNumber;
            const usedDateAsTitle = !supplierName && !d.docketNumber;
            const cardTitle = supplierName || (d.docketNumber ? `Docket #${d.docketNumber}` : formatDate(d.date));
            const cardMeta = [
              usedDateAsTitle ? null : formatDate(d.date),
              d.time || null,
              d.docketNumber && !usedDocketAsTitle ? `Docket #${d.docketNumber}` : null,
            ].filter(Boolean).join(" · ");
            return (
              <Pressable key={d.id} style={styles.card} onPress={() => setExpandedId(expanded ? null : d.id)}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardSupplier}>{cardTitle}</Text>
                    {!!cardMeta && <Text style={styles.cardMeta}>{cardMeta}</Text>}
                  </View>
                  <View style={{ gap: 4, alignItems: "flex-end" }}>
                    {cond && (
                      <View style={[styles.badge, { backgroundColor: cond.color + "22" }]}>
                        <Text style={[styles.badgeText, { color: cond.color }]}>{cond.label}</Text>
                      </View>
                    )}
                    {status && (
                      <View style={[styles.badge, { backgroundColor: status.color + "22" }]}>
                        <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
                      </View>
                    )}
                  </View>
                </View>

                {d.items.length > 0 && (
                  <View style={styles.itemsList}>
                    {d.items.slice(0, expanded ? undefined : 2).map((item, i) => (
                      <View key={i} style={styles.itemRow}>
                        <View style={styles.itemDot} />
                        <Text style={styles.itemText}>{item}</Text>
                      </View>
                    ))}
                    {!expanded && d.items.length > 2 && (
                      <Text style={styles.moreText}>+{d.items.length - 2} more items</Text>
                    )}
                  </View>
                )}

                {expanded && (
                  <View style={styles.expandDetail}>
                    {!!d.purchaseOrder && <DetailRow icon="document-text-outline" label="Purchase Order" value={d.purchaseOrder} />}
                    {!!d.driverName && <DetailRow icon="car-outline" label="Driver" value={[d.driverName, d.vehicleReg].filter(Boolean).join(" · ")} />}
                    {!!d.receivedBy && <DetailRow icon="person-outline" label="Received By" value={d.receivedBy} />}
                    {!!d.storageLocation && <DetailRow icon="location-outline" label="Storage Location" value={d.storageLocation} />}
                    {!!d.damageDescription && <DetailRow icon="warning-outline" label="Damage Notes" value={d.damageDescription} />}
                    {!!d.nonConformances && <DetailRow icon="alert-circle-outline" label="Non-Conformances" value={d.nonConformances} />}
                    {!!d.notes && <DetailRow icon="chatbubble-outline" label="Notes" value={d.notes} />}
                    <View style={styles.deleteRow}>
                      <Pressable style={styles.exportBtn} onPress={() => handleExportDelivery(d)}>
                        <Ionicons name="download-outline" size={14} color={Colors.primary} />
                        <Text style={styles.exportBtnText}>Export Docket</Text>
                      </Pressable>
                      <Pressable style={styles.deleteBtn} onPress={() => handleDelete(d.id)}>
                        <Ionicons name="trash-outline" size={14} color={Colors.error} />
                        <Text style={styles.deleteBtnText}>Delete Record</Text>
                      </Pressable>
                    </View>
                  </View>
                )}

                <View style={styles.expandIndicator}>
                  <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.textTertiary} />
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Delivery Form */}
      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <View style={[formStyles.container, { paddingTop: insets.top + 16 }]}>
          <View style={formStyles.modalHeader}>
            <Pressable onPress={() => { setShowForm(false); resetForm(); }}>
              <Ionicons name="close" size={24} color={Colors.text} />
            </Pressable>
            <Text style={formStyles.modalTitle}>Delivery Docket</Text>
            <Pressable
              style={[formStyles.submitBtn, saving && { opacity: 0.6 }]}
              onPress={handleAdd}
              disabled={saving}
            >
              {saving ? <ActivityIndicator color={Colors.white} size="small" /> : <Text style={formStyles.submitBtnText}>Save</Text>}
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={formStyles.scroll} keyboardShouldPersistTaps="handled">
            {/* Section 1 – Docket Info */}
            <SectionHeader title="1 · Docket Information" />
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Docket / Reference #">
                  <TextInput style={formStyles.input} value={docketNumber} onChangeText={setDocketNumber} placeholder="e.g. D-0042" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Purchase Order / Job #">
                  <TextInput style={formStyles.input} value={purchaseOrder} onChangeText={setPurchaseOrder} placeholder="PO number" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Date" required>
                  <TextInput style={formStyles.input} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Time">
                  <TextInput style={formStyles.input} value={time} onChangeText={setTime} placeholder="HH:MM" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
            </View>

            {/* Section 2 – Supplier & Vehicle */}
            <SectionHeader title="2 · Supplier & Transport" />
            <Field label="Supplier Name" required>
              <TextInput style={formStyles.input} value={supplier} onChangeText={setSupplier} placeholder="Company name" placeholderTextColor={Colors.textTertiary} />
            </Field>
            <Field label="Supplier Contact">
              <TextInput style={formStyles.input} value={supplierContact} onChangeText={setSupplierContact} placeholder="Phone or email" placeholderTextColor={Colors.textTertiary} keyboardType="email-address" />
            </Field>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Driver Name">
                  <TextInput style={formStyles.input} value={driverName} onChangeText={setDriverName} placeholder="Driver's name" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Vehicle Rego / Truck #">
                  <TextInput style={formStyles.input} value={vehicleReg} onChangeText={setVehicleReg} placeholder="e.g. ABC-123" placeholderTextColor={Colors.textTertiary} autoCapitalize="characters" />
                </Field>
              </View>
            </View>

            {/* Section 3 – Materials */}
            <SectionHeader title="3 · Materials Delivered" />
            {lineItems.map((item, index) => (
              <LineItemRow
                key={index}
                item={item}
                index={index}
                onChange={(field, value) => updateLineItem(index, field, value)}
                onRemove={() => removeLineItem(index)}
              />
            ))}
            <Pressable style={formStyles.addItemBtn} onPress={addLineItem}>
              <Ionicons name="add-circle-outline" size={18} color={Colors.accent} />
              <Text style={formStyles.addItemText}>Add Another Item</Text>
            </Pressable>

            {/* Section 4 – Receipt & Condition */}
            <SectionHeader title="4 · Receipt & Condition" />
            <Field label="Received By">
              <TextInput style={formStyles.input} value={receivedBy} onChangeText={setReceivedBy} placeholder="Name of person signing off" placeholderTextColor={Colors.textTertiary} />
            </Field>
            <Field label="Overall Condition on Arrival">
              <ChipGroup options={conditions} value={conditionOnArrival} onChange={setConditionOnArrival} meta={CONDITION_META} />
            </Field>
            {conditionOnArrival !== "good" && (
              <Field label="Damage / Defect Description">
                <TextInput
                  style={[formStyles.input, formStyles.multiline]}
                  value={damageDescription}
                  onChangeText={setDamageDescription}
                  placeholder="Describe any damage, shortfall, or defects observed…"
                  placeholderTextColor={Colors.textTertiary}
                  multiline
                  textAlignVertical="top"
                />
              </Field>
            )}
            <Field label="Storage Location on Site">
              <TextInput style={formStyles.input} value={storageLocation} onChangeText={setStorageLocation} placeholder="e.g. Site compound, Level 3 lay-down area" placeholderTextColor={Colors.textTertiary} />
            </Field>

            {/* Section 5 – Quality */}
            <SectionHeader title="5 · Quality & Status" />
            <Field label="Non-Conformances / Discrepancies">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={nonConformances}
                onChangeText={setNonConformances}
                placeholder="Note any items not matching the order, substitutions, or missing items…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>
            <Field label="Delivery Status">
              <ChipGroup options={statuses} value={deliveryStatus} onChange={setDeliveryStatus} meta={STATUS_META} />
            </Field>
            <Field label="Additional Notes">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Any other notes for the record…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>

            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon as never} size={14} color={Colors.textTertiary} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: Colors.white },
  headerSub: { fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 1 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
  },
  addBtnText: { color: Colors.white, fontSize: 14, fontWeight: "700" },
  summaryBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.primary + "12", padding: 12, paddingHorizontal: 16,
  },
  summaryText: { fontSize: 14, color: Colors.primary, fontWeight: "600" },
  card: {
    backgroundColor: Colors.surface, borderRadius: 16, padding: 14,
    shadowColor: Colors.black, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10 },
  cardSupplier: { fontSize: 15, fontWeight: "700", color: Colors.text },
  cardMeta: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  itemsList: { gap: 5, marginBottom: 6 },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  itemDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: Colors.accent, marginTop: 7 },
  itemText: { flex: 1, fontSize: 13, color: Colors.text, lineHeight: 19 },
  moreText: { fontSize: 12, color: Colors.textTertiary, marginLeft: 13, marginTop: 2 },
  expandDetail: { marginTop: 12, gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  detailRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  detailLabel: { fontSize: 11, color: Colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.2 },
  detailValue: { fontSize: 13, color: Colors.text, lineHeight: 18 },
  deleteRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  deleteBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: Colors.error + "44" },
  deleteBtnText: { fontSize: 13, color: Colors.error, fontWeight: "600" },
  exportBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: Colors.primary + "44" },
  exportBtnText: { fontSize: 13, color: Colors.primary, fontWeight: "600" },
  expandIndicator: { alignItems: "center", marginTop: 6 },
});

const formStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.surface },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceSecondary,
  },
  modalTitle: { fontSize: 17, fontWeight: "700", color: Colors.text },
  submitBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  submitBtnText: { color: Colors.white, fontSize: 14, fontWeight: "700" },
  scroll: { padding: 20, gap: 12 },
  sectionHeader: {
    fontSize: 13, fontWeight: "800", color: Colors.text,
    textTransform: "uppercase", letterSpacing: 0.6,
    marginTop: 8, marginBottom: 8,
    paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600", color: Colors.text },
  required: { color: Colors.error },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 12,
    padding: 12, fontSize: 14, color: Colors.text, backgroundColor: Colors.background,
  },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border,
  },
  chipText: { fontSize: 13, color: Colors.text, fontWeight: "600" },
  chipTextActive: { color: Colors.white },
  lineItemCard: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 14,
    padding: 12, gap: 10, backgroundColor: Colors.background,
  },
  lineItemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lineItemIndex: { fontSize: 12, fontWeight: "700", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.3 },
  miniChip: {
    flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 8,
    backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border,
  },
  miniChipText: { fontSize: 12, color: Colors.text, fontWeight: "600" },
  addItemBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderWidth: 1, borderColor: Colors.accent, borderRadius: 12,
    paddingVertical: 12, borderStyle: "dashed",
  },
  addItemText: { fontSize: 14, color: Colors.accent, fontWeight: "600" },
});
