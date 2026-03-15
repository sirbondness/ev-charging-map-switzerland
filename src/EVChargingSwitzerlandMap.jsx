import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import MarkerClusterGroup from "react-leaflet-cluster";

const GEOJSON_URL =
    "https://data.geo.admin.ch/ch.bfe.ladestellen-elektromobilitaet/data/ch.bfe.ladestellen-elektromobilitaet_de.json";

const DEFAULT_CENTER = [46.8182, 8.2275];
const DEFAULT_ZOOM = 8;

const DEFAULT_FILTERS = {
    search: "",
    minPower: 0,
    maxPrice: 1.0,
    onlyWithKnownPrice: false,
    adHocOnly: false,
    open24hOnly: false,
    connectorTypes: {
        CCS: true,
        Type2: true,
        CHAdeMO: false,
        Tesla: false,
    },
};

const cityCoordinates = {
    zürich: [47.3769, 8.5417],
    zurich: [47.3769, 8.5417],
    bern: [46.948, 7.4474],
    basel: [47.5596, 7.5886],
    luzern: [47.0502, 8.3093],
    lucerne: [47.0502, 8.3093],
    genf: [46.2044, 6.1432],
    geneva: [46.2044, 6.1432],
    lausanne: [46.5197, 6.6323],
    winterthur: [47.4988, 8.7237],
    "st. gallen": [47.4245, 9.3767],
    "st gallen": [47.4245, 9.3767],
    stgallen: [47.4245, 9.3767],
    lugano: [46.0037, 8.9511],
};

function getArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
}

function flattenStrings(input) {
    if (input == null) return [];
    if (typeof input === "string") return [input];
    if (typeof input === "number" || typeof input === "boolean") return [String(input)];
    if (Array.isArray(input)) return input.flatMap(flattenStrings);
    if (typeof input === "object") return Object.values(input).flatMap(flattenStrings);
    return [];
}

function extractCoordinatePair(raw) {
    if (Array.isArray(raw?.geometry?.coordinates)) {
        const [lng, lat] = raw.geometry.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat: Number(lat), lng: Number(lng) };
        }
    }

    const props = raw?.properties ?? raw;
    const lat = props?.latitude ?? props?.lat ?? props?.Latitude ?? props?.Lat;
    const lng = props?.longitude ?? props?.lng ?? props?.Longitude ?? props?.Lng;

    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
        return { lat: Number(lat), lng: Number(lng) };
    }

    return { lat: NaN, lng: NaN };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  const text = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return decodeHtmlEntities(text);
}

function extractDescriptionHtml(props) {
    return props?.description || props?.Description || "";
}

function extractFieldFromDescription(props, fieldName) {
    const html = extractDescriptionHtml(props);
    if (!html) return "";

    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
        `<td[^>]*>\\s*${escaped}\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
        "i"
    );

    const match = html.match(regex);
    if (!match) return "";

    return stripHtml(match[1]);
}

function extractPrice(props) {
  const html = extractDescriptionHtml(props);
  if (!html) return "";

  const match = html.match(
    /<td[^>]*class="cell-left"[^>]*>[\s\S]*?Preis[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i
  );

  if (!match) return "";

  return stripHtml(match[1]).replace(/\s+/g, " ").trim();
}

function extractPricePerKwh(priceText) {
  if (!priceText) return null;

  const match = String(priceText).match(/(\d+(?:[.,]\d+)?)\s*CHF\s*\/\s*kWh/i);
  if (!match) return null;

  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function extractPowerKw(props) {
    const html = extractDescriptionHtml(props);
    if (!html) return 0;

    const matches = [...html.matchAll(/(\d+(?:\.\d+)?)\s*kW/gi)];
    if (matches.length === 0) return 0;

    const values = matches
        .map((m) => Number(m[1]))
        .filter(Number.isFinite);

    return values.length ? Math.max(...values) : 0;
}

function extractConnectorTypes(props) {
    const text = stripHtml(extractDescriptionHtml(props)).toLowerCase();
    const types = new Set();

    if (text.includes("typ 2") || text.includes("type 2")) types.add("Type2");
    if (text.includes("ccs")) types.add("CCS");
    if (text.includes("chademo")) types.add("CHAdeMO");
    if (text.includes("tesla")) types.add("Tesla");

    return [...types];
}


function extractAdHocPayment(props) {
    const auth = extractFieldFromDescription(props, "Authentifizierung").toLowerCase();

    if (!auth) return false;

    return [
        "direktzahlung",
        "qr-code",
        "app",
        "smartphone",
        "credit card",
        "debit card",
        "visa",
        "mastercard",
    ].some((term) => auth.includes(term));
}



function extractIsOpen24Hours(props) {
    const access = extractFieldFromDescription(props, "Zugang").toLowerCase();
    if (!access) return false;

    return access.includes("öffentlich");
}

function extractStationName(props) {
    const locationId = props?.location_id || props?.LocationId || props?.locationId;
    const network = extractFieldFromDescription(props, "Ladenetzwerk");

    if (network && locationId) return `${network} (${locationId})`;
    if (network) return network;
    if (locationId) return locationId;

    return "Unbenannte Station";
}

function extractAddress(props) {
    return extractFieldFromDescription(props, "Standort");
}

function extractCity(props) {
    const address = extractAddress(props);
    if (!address) return "";

    const match = address.match(/\b\d{4}\s+([^,]+)$/);
    if (match) return match[1].trim();

    const parts = address.split(",");
    return parts[parts.length - 1]?.trim() || "";
}

function normalizeStation(raw, index) {
    const props = raw?.properties ?? raw;
    const { lat, lng } = extractCoordinatePair(raw);
    const price = extractPrice(props);

    return {
        id: props?.location_id ?? props?.id ?? props?.ID ?? raw?.id ?? `station-${index}`,
        name: extractStationName(props),
        city: extractCity(props),
        address: extractAddress(props),
        lat,
        lng,
        powerKw: extractPowerKw(props),
        adHocPayment: extractAdHocPayment(props),
        open24h: extractIsOpen24Hours(props),
        connectorTypes: extractConnectorTypes(props),
        operator: extractFieldFromDescription(props, "Ladenetzwerk"),
        availability: props?.Availability || "",
        price: extractPrice(props),
        pricePerKwh: extractPricePerKwh(price),
        raw: props,
    };
}

function normalizeDataset(payload) {
    if (Array.isArray(payload)) return payload.map(normalizeStation);
    if (Array.isArray(payload?.features)) return payload.features.map(normalizeStation);
    if (Array.isArray(payload?.items)) return payload.items.map(normalizeStation);
    return [];
}

function powerBand(powerKw) {
    if (powerKw >= 150) return "fast";
    if (powerKw >= 50) return "medium";
    return "slow";
}

function markerIcon(powerKw) {
    const band = powerBand(powerKw);
    const background = band === "fast" ? "#dc2626" : band === "medium" ? "#ea580c" : "#2563eb";

    return L.divIcon({
        className: "",
        html: `<div style="width:18px;height:18px;border-radius:999px;background:${background};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35)"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -10],
    });
}

function MapFlyTo({ center, zoom = 11 }) {
    const map = useMap();

    useEffect(() => {
        if (center) map.flyTo(center, zoom, { duration: 0.8 });
    }, [center, zoom, map]);

    return null;
}

function getSearchCenter(search, filteredStations) {
    const value = search.trim().toLowerCase();
    if (!value) return null;

    const firstStation = filteredStations.find((station) => {
        const haystack = [station.name, station.city, station.address, station.operator]
            .join(" ")
            .toLowerCase();
        return haystack.includes(value);
    });

    if (firstStation) return [firstStation.lat, firstStation.lng];
    return cityCoordinates[value] || null;
}

const styles = {
    page: {
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "16px",
        fontFamily: "Arial, sans-serif",
        color: "#0f172a",
    },
    layout: {
        maxWidth: "1800px",
        margin: "0 auto",
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        gap: "24px",
        alignItems: "start",
    },
    panel: {
        background: "white",
        borderRadius: "16px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
        border: "1px solid #e2e8f0",
        overflow: "hidden",
    },
    panelHeader: {
        padding: "18px 20px",
        borderBottom: "1px solid #e2e8f0",
        fontSize: "20px",
        fontWeight: 700,
    },
    panelBody: {
        padding: "20px",
    },
    field: {
        marginBottom: "18px",
    },
    label: {
        display: "block",
        marginBottom: "8px",
        fontWeight: 600,
        fontSize: "14px",
    },
    input: {
        width: "100%",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid #cbd5e1",
        fontSize: "14px",
        boxSizing: "border-box",
    },
    checkboxRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "10px",
        fontSize: "14px",
    },
    smallText: {
        fontSize: "13px",
        color: "#475569",
    },
    badge: {
        display: "inline-block",
        padding: "4px 8px",
        borderRadius: "999px",
        border: "1px solid #cbd5e1",
        fontSize: "12px",
        marginRight: "6px",
        marginBottom: "6px",
        background: "#fff",
        color: "#334155",
    },
    resultList: {
        maxHeight: "340px",
        overflowY: "auto",
        marginTop: "12px",
    },
    resultCard: {
        width: "100%",
        textAlign: "left",
        padding: "14px",
        borderRadius: "14px",
        border: "1px solid #e2e8f0",
        background: "white",
        marginBottom: "10px",
        cursor: "pointer",
        color: "#0f172a",
        appearance: "none",
        WebkitAppearance: "none",
    },
    mapWrap: {
        height: "78vh",
        minHeight: "700px",
        width: "100%",
    },
    button: {
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid #cbd5e1",
        background: "white",
        cursor: "pointer",
        fontWeight: 600,
    },
};

export default function EVChargingSwitzerlandMap() {
    const [stations, setStations] = useState([]);
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [selectedStation, setSelectedStation] = useState(null);
    const [mapTarget, setMapTarget] = useState(null);
    const hasAppliedInitialTarget = useRef(false);

    useEffect(() => {
        let cancelled = false;

        async function loadStations() {
            setLoading(true);
            setError("");

            try {
                const response = await fetch(GEOJSON_URL);
                if (!response.ok) {
                    throw new Error(`API-Fehler beim Laden der Stationen: ${response.status}`);
                }

                const payload = await response.json();
                console.log("RAW PAYLOAD:", payload);

                const normalized = normalizeDataset(payload).filter(
                    (station) => Number.isFinite(station.lat) && Number.isFinite(station.lng)
                );

                console.log("FIRST FEATURE:", payload?.features?.[0]);
                console.log("FIRST FEATURE PROPERTIES:", payload?.features?.[0]?.properties);
                console.log("FIRST NORMALIZED STATION:", normalized[0]);

                if (!cancelled) setStations(normalized);
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Unbekannter Fehler beim Laden der Stationen");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadStations();
        return () => {
            cancelled = true;
        };
    }, []);

    const filteredStations = useMemo(() => {
        const searchLower = filters.search.trim().toLowerCase();
        const activeConnectorTypes = Object.entries(filters.connectorTypes)
            .filter(([, enabled]) => enabled)
            .map(([key]) => key);

        return stations.filter((station) => {
            if (filters.adHocOnly && !station.adHocPayment) return false;
            if (filters.open24hOnly && !station.open24h) return false;
            if (station.powerKw < filters.minPower) return false;
            if (filters.onlyWithKnownPrice && station.pricePerKwh == null) return false;
            if (station.pricePerKwh != null && station.pricePerKwh > filters.maxPrice) {
                return false;
            }
            if (
                activeConnectorTypes.length > 0 &&
                station.connectorTypes.length > 0 &&
                !activeConnectorTypes.some((type) => station.connectorTypes.includes(type))
            ) {
                return false;
            }

            if (!searchLower) return true;

            const haystack = [station.name, station.city, station.address, station.operator]
                .join(" ")
                .toLowerCase();

            return haystack.includes(searchLower);
        });
    }, [stations, filters]);

    useEffect(() => {
        const center = getSearchCenter(filters.search, filteredStations);
        if (center) setMapTarget(center);
    }, [filters.search, filteredStations]);

    useEffect(() => {
        if (!hasAppliedInitialTarget.current && filteredStations.length > 0) {
            hasAppliedInitialTarget.current = true;
            setMapTarget([filteredStations[0].lat, filteredStations[0].lng]);
        }
    }, [filteredStations]);

    return (
        <div style={styles.page}>
            <div style={styles.layout}>
                <div style={styles.panel}>
                    <div style={styles.panelHeader}>Ladestationen Schweiz</div>
                    <div style={styles.panelBody}>
                        <div style={styles.field}>
                            <label style={styles.label}>Ort / Betreiber / Station suchen</label>
                            <input
                                style={styles.input}
                                placeholder="z. B. Zürich, Bern, GOFAST"
                                value={filters.search}
                                onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
                            />
                        </div>

                        <div style={styles.field}>
                            <label style={styles.label}>Mindest-Ladeleistung: {filters.minPower} kW</label>
                            <input
                                type="range"
                                min="0"
                                max="350"
                                step="10"
                                value={filters.minPower}
                                onChange={(e) =>
                                    setFilters((prev) => ({ ...prev, minPower: Number(e.target.value) }))
                                }
                                style={{ width: "100%" }}
                            />
                        </div>

                        <div style={styles.field}>
                            <label style={styles.label}>
                                Maximalpreis: {filters.maxPrice.toFixed(2)} CHF/kWh
                            </label>
                            <input
                                type="range"
                                min="0.20"
                                max="1.20"
                                step="0.01"
                                value={filters.maxPrice}
                                onChange={(e) =>
                                    setFilters((prev) => ({ ...prev, maxPrice: Number(e.target.value) }))
                                }
                                style={{ width: "100%" }}
                                 />
                                 <div style={{ ...styles.smallText, marginTop: "6px" }}>
                                    Zeigt Stationen bis zu diesem Preis pro kWh
                                 </div>
                        </div>

<div style={styles.field}>
  <label style={styles.checkboxRow}>
    <input
      type="checkbox"
      checked={filters.onlyWithKnownPrice}
      onChange={(e) =>
        setFilters((prev) => ({
          ...prev,
          onlyWithKnownPrice: e.target.checked,
        }))
      }
    />
    Nur Stationen mit erkanntem Preis
  </label>
</div>

                        <div style={styles.field}>
                            <label style={styles.checkboxRow}>
                                <input
                                    type="checkbox"
                                    checked={filters.adHocOnly}
                                    onChange={(e) =>
                                        setFilters((prev) => ({ ...prev, adHocOnly: e.target.checked }))
                                    }
                                />
                                Nur Ad-hoc-Bezahlung
                            </label>

                            <label style={styles.checkboxRow}>
                                <input
                                    type="checkbox"
                                    checked={filters.open24hOnly}
                                    onChange={(e) =>
                                        setFilters((prev) => ({ ...prev, open24hOnly: e.target.checked }))
                                    }
                                />
                                Nur 24h geöffnet
                            </label>
                        </div>

                        <div style={styles.field}>
                            <div style={styles.label}>Steckertypen</div>
                            {Object.entries(filters.connectorTypes).map(([type, checked]) => (
                                <label key={type} style={styles.checkboxRow}>
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={(e) =>
                                            setFilters((prev) => ({
                                                ...prev,
                                                connectorTypes: {
                                                    ...prev.connectorTypes,
                                                    [type]: e.target.checked,
                                                },
                                            }))
                                        }
                                    />
                                    {type}
                                </label>
                            ))}
                        </div>

                        <div style={{ ...styles.field, border: "1px solid #e2e8f0", borderRadius: "12px", padding: "12px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                                <strong>{filteredStations.length} Treffer</strong>
                                <button
                                    style={styles.button}
                                    onClick={() => {
                                        setFilters(DEFAULT_FILTERS);
                                        setMapTarget(DEFAULT_CENTER);
                                    }}
                                >
                                    Filter zurücksetzen
                                </button>
                            </div>
                            <div style={{ marginTop: "10px" }}>
                                <span style={styles.badge}>Blau: bis 49 kW</span>
                                <span style={styles.badge}>Orange: 50–149 kW</span>
                                <span style={styles.badge}>Rot: ab 150 kW</span>
                            </div>
                        </div>

                        {loading && <p style={styles.smallText}>Lade Stationen…</p>}
                        {error && <p style={{ ...styles.smallText, color: "#b91c1c" }}>{error}</p>}

                        <div style={styles.resultList}>
                            {filteredStations.map((station) => {
                                const displayName =
                                    station.name ||
                                    station.operator ||
                                    station.id ||
                                    "Unbenannte Station";

                                const displayLocation =
                                    station.city ||
                                    station.address ||
                                    station.availability ||
                                    "Ort unbekannt";

                                return (
                                    <button
                                        key={station.id}
                                        style={styles.resultCard}
                                        onClick={() => {
                                            setSelectedStation(station);
                                            setMapTarget([station.lat, station.lng]);
                                        }}
                                    >
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
                                            <div>
                                                <div style={{ fontWeight: 700, color: "#0f172a" }}>{displayName}</div>
                                                <div style={{ ...styles.smallText, color: "#475569" }}>{displayLocation}</div>
                                                
                                               {station.price && (
                                                    <div style={{ ...styles.smallText, marginTop: "4px", color: "#0f172a" }}>
                                                        Preis: {station.price}
                                                        {station.pricePerKwh != null && (
                                                            <span style={{ marginLeft: "6px", color: "#475569" }}>
                                                                ({station.pricePerKwh.toFixed(2)} CHF/kWh)
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                <span style={styles.badge}>
                                                    {station.powerKw ? `${Math.round(station.powerKw)} kW` : "–"}
                                                </span>
                                            </div>

                                            <div style={{ marginTop: "10px" }}>
                                                {station.adHocPayment && <span style={styles.badge}>Ad-hoc</span>}
                                                {station.open24h && <span style={styles.badge}>24h</span>}
                                                {station.availability && <span style={styles.badge}>{station.availability}</span>}
                                                {station.connectorTypes?.map((type) => (
                                                    <span key={type} style={styles.badge}>{type}</span>
                                                ))}
                                            </div>
                                        </div>    
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>

                <div>
                    <div style={styles.panel}>
                        <div style={styles.panelHeader}>Karte</div>
                        <div style={styles.mapWrap}>
                            <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
                                <TileLayer
                                    attribution='&copy; OpenStreetMap contributors'
                                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                />

                                {mapTarget && <MapFlyTo center={mapTarget} zoom={11} />}

                                <MarkerClusterGroup
                                    chunkedLoading
                                    maxClusterRadius={50}
                                    spiderfyOnMaxZoom={true}
                                    showCoverageOnHover={false}
                                >
                                    {filteredStations.map((station) => (
                                        <Marker
                                            key={station.id}
                                            position={[station.lat, station.lng]}
                                            icon={markerIcon(station.powerKw)}
                                            eventHandlers={{
                                                click: () => setSelectedStation(station),
                                            }}
                                        >
                                            <Popup>
                                                <div>
                                                    <div style={{ fontWeight: 700 }}>
                                                        {station.name || station.operator || station.id}
                                                    </div>
                                                    <div>{station.city || "Ort unbekannt"}</div>
                                                    <div>{station.address || ""}</div>
                                                    <div>Leistung: {Math.round(station.powerKw)} kW</div>
                                                    <div>Ad-hoc: {station.adHocPayment ? "Ja" : "Nein"}</div>
                                                    <div>Status: {station.availability || "Unbekannt"}</div>
                                                    {station.price && <div>Preis: {station.price}</div>}
                                                    {station.connectorTypes.length > 0 && (
                                                        <div>Stecker: {station.connectorTypes.join(", ")}</div>
                                                    )}
                                                </div>
                                            </Popup>
                                        </Marker>
                                    ))}
                                </MarkerClusterGroup>
                            </MapContainer>
                        </div>
                    </div>

                    {selectedStation && (
                        <div style={{ ...styles.panel, marginTop: "24px" }}>
                            <div style={styles.panelHeader}>{selectedStation.name}</div>
                            <div style={styles.panelBody}>
                                <p><strong>Ort:</strong> {selectedStation.city || "–"}</p>
                                <p><strong>Adresse:</strong> {selectedStation.address || "–"}</p>
                                <p><strong>Betreiber:</strong> {selectedStation.operator || "–"}</p>
                                <p><strong>Max. Leistung:</strong> {Math.round(selectedStation.powerKw)} kW</p>
                                <p><strong>Ad-hoc-Bezahlung:</strong> {selectedStation.adHocPayment ? "Ja" : "Nein"}</p>
                                <p><strong>24h geöffnet:</strong> {selectedStation.open24h ? "Ja" : "Nein"}</p>
                                <p><strong>Preis:</strong> {selectedStation.price || "–"}</p>
                                <p><strong>Steckertypen:</strong> {selectedStation.connectorTypes.join(", ") || "–"}</p>
                                <p><strong>Koordinaten:</strong> {selectedStation.lat}, {selectedStation.lng}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
