//! S.M.A.R.T. disk health commands (smartmontools / WMI / system_profiler).

use tauri::State;

use crate::{AppState, JsonResult};
#[cfg(target_os = "macos")]
use crate::in_mac_sandbox;
#[cfg(not(target_os = "windows"))]
use crate::run_output;

#[cfg(target_os = "linux")]
fn run_smartctl_linux(device_id: &str) -> Option<String> {
    // Direct call first (works when user has disk access / is root).
    if let Some(s) = run_output("smartctl", &["-j", "-a", &format!("/dev/{}", device_id)]) {
        return Some(s);
    }
    // Fall back to pkexec so the polkit dialog elevates smartctl once.
    run_output("pkexec", &["smartctl", "-j", "-a", &format!("/dev/{}", device_id)])
}


/// Normalize smartmontools JSON (`smartctl -j -a`) into a common report shape.
/// Used only on macOS/Linux — Windows reads SMART natively via DeviceIoControl.
#[cfg(not(target_os = "windows"))]
fn smart_from_smartctl(v: &serde_json::Value, device_id: &str) -> Option<serde_json::Value> {
    let model = v.pointer("/model_name").and_then(|x| x.as_str()).unwrap_or(device_id).to_string();
    let serial = v.pointer("/serial_number").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let firmware = v.pointer("/firmware_version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let dev_type = v.pointer("/device/type").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let passed = v.pointer("/smart_status/passed").and_then(|x| x.as_bool()).unwrap_or(false);
    let temp = v.pointer("/temperature/current").and_then(|x| x.as_u64()).map(|x| x as f64);
    let powh = v.pointer("/power_on_time/hours").and_then(|x| x.as_u64()).unwrap_or(0);
    let capacity = v.pointer("/user_capacity/bytes").and_then(|x| x.as_u64()).unwrap_or(0);

    let mut attributes: Vec<serde_json::Value> = Vec::new();

    // Devices that report no SMART support (e.g. virtualized SCSI disks)
    // still expose model/capacity/interface â€” return a report that says
    // "not supported" instead of fabricating a health score.
    let support_available = v.pointer("/smart_support/available").and_then(|x| x.as_bool());
    let unsupported = support_available == Some(false) && !dev_type.contains("nvme");

    if dev_type.contains("nvme") {
        let nvme_fields: &[(&str, &str)] = &[
            ("02", "Temperature"), ("03", "Available Spare"), ("04", "Available Spare Threshold"),
            ("05", "Percentage Used"), ("06", "Data Units Read"), ("07", "Data Units Written"),
            ("08", "Host Read Commands"), ("09", "Host Write Commands"), ("0a", "Controller Busy Time"),
            ("0b", "Power Cycles"), ("0c", "Power On Hours"), ("0d", "Unsafe Shutdowns"),
            ("0e", "Media Errors"), ("0f", "Num Err Log Entries"), ("10", "Warning Temp Time"),
            ("11", "Critical Comp Temp Time"), ("12", "Thermal Sensor 1"), ("13", "Thermal Sensor 2"),
        ];
        if let Some(log) = v.pointer("/nvme_smart_health_information_log") {
            let critical = log.get("critical_warning").and_then(|x| x.as_u64()).unwrap_or(0);
            for (id, name) in nvme_fields {
                let key = name.split_whitespace().collect::<Vec<_>>().join("_");
                let val = log.get(&key).and_then(|x| x.as_u64());
                attributes.push(serde_json::json!({
                    "id": id, "name": name,
                    "current": val, "worst": null, "threshold": null,
                    "raw": val.map(|x| x.to_string()).unwrap_or_default(),
                    "status": "OK",
                }));
            }
            attributes.insert(0, serde_json::json!({
                "id": "01", "name": "Critical Warning",
                "current": critical, "worst": null, "threshold": null,
                "raw": critical.to_string(),
                "status": if critical > 0 { "FAIL" } else { "OK" },
            }));
        }
    } else if let Some(table) = v.pointer("/ata_smart_attributes/table") {
        if let Some(arr) = table.as_array() {
            for a in arr {
                let id = a.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let val = a.get("value").and_then(|x| x.as_u64());
                let worst = a.get("worst").and_then(|x| x.as_u64());
                let thresh = a.get("thresh").and_then(|x| x.as_u64());
                let raw = a.pointer("/raw/string").and_then(|x| x.as_str()).unwrap_or("");
                let failed = a.pointer("/flags/failure").and_then(|x| x.as_bool()).unwrap_or(false);
                attributes.push(serde_json::json!({
                    "id": format!("{:02X}", id), "name": name,
                    "current": val, "worst": worst, "threshold": thresh,
                    "raw": raw, "status": if failed { "FAIL" } else { "OK" },
                }));
            }
        }
    }

    let (score, status) = if unsupported {
        (0u64, "Not Supported")
    } else if passed {
        (100u64, "Healthy")
    } else {
        (30u64, "Critical")
    };
    Some(serde_json::json!({
        "device_id": device_id,
        "model": model, "serial": serial, "firmware": firmware,
        "interface": dev_type.to_uppercase(),
        "capacity": capacity,
        "score": score, "status": status,
        "smart_supported": !unsupported,
        "temperature_c": temp,
        "power_on_hours": powh,
        "attributes": attributes,
        "source": "smartctl",
    }))
}

/// Combine OS health status + SMART attributes into a 0-100 score.
#[cfg(target_os = "windows")]
fn smart_health_from_attrs(health: i64, wear: Option<f64>, temp: Option<f64>, read_unc: u64, write_unc: u64) -> (u64, &'static str) {
    let mut score: f64 = 100.0;
    match health {
        1 => score -= 20.0,
        2 => score -= 60.0,
        _ => {}
    }
    if let Some(w) = wear {
        if w > 90.0 { score -= 40.0; }
        else if w > 75.0 { score -= 20.0; }
        else if w > 50.0 { score -= 8.0; }
    }
    if let Some(t) = temp {
        if t >= 60.0 { score -= 30.0; }
        else if t >= 50.0 { score -= 10.0; }
        else if t >= 45.0 { score -= 4.0; }
    }
    if read_unc + write_unc > 0 { score -= 15.0; }
    let score = score.clamp(0.0, 100.0).round() as u64;
    let status = if score >= 85 { "Healthy" } else if score >= 55 { "Warning" } else { "Critical" };
    (score, status)
}

/// Native Windows SMART report built from `DeviceIoControl` calls — no
/// PowerShell / smartctl subprocess. Returns None if the device can't be
/// opened (e.g. missing admin rights).
#[cfg(target_os = "windows")]
fn native_smart_report(device_id: &str) -> Option<serde_json::Value> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetFileSizeEx, FILE_ACCESS_FLAGS, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    const STORAGE_DEVICE_PROPERTY: u32 = 0;
    const STORAGE_DEVICE_TEMP_PROPERTY: u32 = 39;
    const STORAGE_DEVICE_PROTOCOL_SPECIFIC: u32 = 50;
    const PROPERTY_STANDARD_QUERY: u32 = 0;
    const PROTOCOL_TYPE_NVME: u32 = 3;
    const NVME_DATA_TYPE_LOG_PAGE: u32 = 2;
    const NVME_LOG_SMART: u32 = 0x02;
    const HDR_LEN: usize = 48; // STORAGE_PROPERTY_QUERY (8) + STORAGE_PROTOCOL_SPECIFIC_DATA (40)

    let dev = format!("\\\\.\\PHYSICALDRIVE{}", device_id);
    let wide: Vec<u16> = dev.encode_utf16().chain(std::iter::once(0)).collect();
    // Prefer read+write (needed for NVMe passthrough); fall back to read-only
    // so drives are still visible/queryable without admin rights.
    let (handle, has_write) = match unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_ACCESS_FLAGS(0x8000_0000 | 0x4000_0000), // GENERIC_READ | GENERIC_WRITE
            FILE_SHARE_MODE(1 | 2), // FILE_SHARE_READ | FILE_SHARE_WRITE
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    } {
        Ok(h) => (h, true),
        Err(_) => match unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_ACCESS_FLAGS(0x8000_0000), // GENERIC_READ
                FILE_SHARE_MODE(1 | 2),
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        } {
            Ok(h) => (h, false),
            Err(_) => return None,
        },
    };

    struct Cleanup(HANDLE);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    let _guard = Cleanup(handle);

    fn ioctl(handle: HANDLE, inbuf: &[u8], outbuf: &mut [u8]) -> bool {
        let mut returned: u32 = 0;
        unsafe {
            DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                inbuf.as_ptr() as *const c_void,
                inbuf.len() as u32,
                outbuf.as_mut_ptr() as *mut c_void,
                outbuf.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        }
        .as_bool()
    }

    // ── Device descriptor: model / serial / bus type ──
    let mut prop_in = [0u8; 8];
    prop_in[0..4].copy_from_slice(&STORAGE_DEVICE_PROPERTY.to_le_bytes());
    prop_in[4..8].copy_from_slice(&PROPERTY_STANDARD_QUERY.to_le_bytes());
    let mut desc = [0u8; 1024];
    let mut model = String::new();
    let mut serial = String::new();
    let mut bus_type: u32 = 0;
    if ioctl(handle, &prop_in, &mut desc) {
        let le_u32 = |o: usize| u32::from_le_bytes([desc[o], desc[o + 1], desc[o + 2], desc[o + 3]]);
        bus_type = le_u32(28);
        let vendor_off = le_u32(12) as usize;
        let product_off = le_u32(16) as usize;
        let serial_off = le_u32(24) as usize;
        let cstr = |off: usize| {
            let mut s = String::new();
            let mut i = off;
            while i < desc.len() && desc[i] != 0 {
                s.push(desc[i] as char);
                i += 1;
            }
            s.trim().to_string()
        };
        let vendor = if vendor_off > 0 && vendor_off < desc.len() { cstr(vendor_off) } else { String::new() };
        let product = if product_off > 0 && product_off < desc.len() { cstr(product_off) } else { String::new() };
        model = if !product.is_empty() {
            if vendor.is_empty() { product } else { format!("{} {}", vendor, product) }
        } else {
            vendor
        };
        serial = if serial_off > 0 && serial_off < desc.len() { cstr(serial_off) } else { String::new() };
    }

    // ── Capacity ──
    let mut size: u64 = 0;
    unsafe {
        let mut sz: i64 = 0;
        if GetFileSizeEx(handle, &mut sz).as_bool() && sz > 0 {
            size = sz as u64;
        }
    }

    // ── Temperature (works on every bus type) ──
    // StorageDeviceTemperatureProperty returns STORAGE_TEMPERATURE_DATA:
    //   ULONG Version (0), ULONG Size (4), then STORAGE_TEMPERATURE_INFO[1]
    //   (Index USHORT at 8, Temperature USHORT in Kelvin at 10, ...).
    // Values below 273 K are invalid (0 = not supported), so ignore garbage.
    let mut temp_in = [0u8; 8];
    temp_in[0..4].copy_from_slice(&STORAGE_DEVICE_TEMP_PROPERTY.to_le_bytes());
    temp_in[4..8].copy_from_slice(&PROPERTY_STANDARD_QUERY.to_le_bytes());
    let mut temp_out = [0u8; 64];
    let mut temp_c: Option<f64> = None;
    if ioctl(handle, &temp_in, &mut temp_out) {
        let kelvin = u16::from_le_bytes([temp_out[10], temp_out[11]]);
        if (273..=450).contains(&kelvin) {
            temp_c = Some(kelvin as f64 - 273.0);
        }
    }

    // ── NVMe SMART log page ──
    let is_nvme = bus_type == 17; // BusTypeNvme
    let mut nvme_attrs: Vec<serde_json::Value> = Vec::new();
    let mut critical_warning: u64 = 0;
    let mut avail_spare: Option<u64> = None;
    let mut pct_used: Option<u64> = None;
    let mut power_cycles: Option<u64> = None;
    let mut power_on_hours: u64 = 0;
    let mut media_errors: Option<u64> = None;

    if is_nvme && has_write {
        let mut nvme_in = vec![0u8; HDR_LEN];
        nvme_in[0..4].copy_from_slice(&STORAGE_DEVICE_PROTOCOL_SPECIFIC.to_le_bytes());
        nvme_in[4..8].copy_from_slice(&PROPERTY_STANDARD_QUERY.to_le_bytes());
        nvme_in[8..12].copy_from_slice(&PROTOCOL_TYPE_NVME.to_le_bytes());
        nvme_in[12..16].copy_from_slice(&NVME_DATA_TYPE_LOG_PAGE.to_le_bytes());
        nvme_in[16..20].copy_from_slice(&NVME_LOG_SMART.to_le_bytes());
        nvme_in[24..28].copy_from_slice(&(HDR_LEN as u32).to_le_bytes());
        nvme_in[28..32].copy_from_slice(&512u32.to_le_bytes());
        let mut nvme_out = vec![0u8; HDR_LEN + 512];
        if ioctl(handle, &nvme_in, &mut nvme_out) {
            let log = &nvme_out[HDR_LEN..HDR_LEN + 512];
            critical_warning = log[0] as u64;
            let kelvin = u16::from_le_bytes([log[1], log[2]]);
            if kelvin > 0 {
                temp_c = Some(kelvin as f64 - 273.0);
            }
            avail_spare = Some(log[3] as u64);
            pct_used = Some(log[5] as u64);
            let le_u64 = |o: usize| u64::from_le_bytes(log[o..o + 8].try_into().ok().unwrap_or_default());
            let du_read = le_u64(15);
            let du_written = le_u64(23);
            power_cycles = Some(le_u64(47));
            power_on_hours = le_u64(55);
            let unsafe_shutdowns = le_u64(63);
            media_errors = Some(le_u64(71));
            let num_err = le_u64(79);

            let mk = |id: &str, name: &str, cur: Option<u64>, raw: String, status: &str| {
                serde_json::json!({"id": id, "name": name, "current": cur, "worst": null,
                                   "threshold": null, "raw": raw, "status": status})
            };
            nvme_attrs.push(mk("01", "Critical Warning", Some(critical_warning),
                              critical_warning.to_string(), if critical_warning > 0 { "FAIL" } else { "OK" }));
            nvme_attrs.push(mk("02", "Temperature", temp_c.map(|t| t.round() as u64),
                              temp_c.map(|t| format!("{} C", t.round())).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("03", "Available Spare", avail_spare,
                              avail_spare.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("05", "Percentage Used", pct_used,
                              pct_used.map(|x| format!("{}%", x)).unwrap_or_else(|| "n/a".into()),
                              if pct_used.unwrap_or(0) >= 90 { "WARN" } else { "OK" }));
            nvme_attrs.push(mk("06", "Data Units Read", Some(du_read),
                              Some(du_read).map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("07", "Data Units Written", Some(du_written),
                              Some(du_written).map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("0b", "Power Cycles", power_cycles,
                              power_cycles.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("0c", "Power On Hours", Some(power_on_hours), power_on_hours.to_string(), "OK"));
            nvme_attrs.push(mk("0d", "Unsafe Shutdowns", Some(unsafe_shutdowns),
                              Some(unsafe_shutdowns).map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
            nvme_attrs.push(mk("0e", "Media Errors", media_errors,
                              media_errors.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),
                              if media_errors.unwrap_or(0) > 0 { "WARN" } else { "OK" }));
            nvme_attrs.push(mk("0f", "Num Err Log Entries", Some(num_err),
                              Some(num_err).map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()), "OK"));
        }
    }

    // ── Build the common report ──
    let interface = match bus_type {
        17 => "NVMe", 11 => "SATA", 10 => "SAS", 7 => "USB", 3 => "ATA",
        8 => "RAID", 9 => "iSCSI", 12 => "SD", 13 => "MMC", 18 => "SCM",
        _ => "Unknown",
    };
    let health: i64 = if is_nvme && critical_warning > 0 { 1 } else { 0 };
    let wear = pct_used.map(|x| x as f64);
    let read_u = media_errors.unwrap_or(0);
    let write_u = 0;
    let (score, status) = smart_health_from_attrs(health, wear, temp_c, read_u, write_u);
    let attributes = if is_nvme {
        nvme_attrs
    } else {
        vec![
            serde_json::json!({"id":"01","name":"Health Status","current":health,"worst":null,"threshold":null,"raw":health.to_string(),"status":if health == 0 {"OK"} else {"WARN"}}),
            serde_json::json!({"id":"02","name":"Temperature","current":temp_c.map(|t| t.round() as u64),"worst":null,"threshold":null,"raw":temp_c.map(|t| format!("{} C", t.round())).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
            serde_json::json!({"id":"0c","name":"Power On Hours","current":Some(power_on_hours),"worst":null,"threshold":null,"raw":power_on_hours.to_string(),"status":"OK"}),
        ]
    };
    Some(serde_json::json!({
        "device_id": device_id,
        "friendly_name": model,
        "model": model,
        "serial": serial,
        "firmware": "",
        "interface": interface,
        "media_type": if is_nvme { 4 } else { -1 },
        "capacity": size,
        "health": health,
        "score": score,
        "status": status,
        "temperature_c": temp_c,
        "wear": wear,
        "power_on_hours": power_on_hours,
        "power_cycles": power_cycles,
        "percentage_used": pct_used,
        "available_spare": avail_spare,
        "media_errors": media_errors,
        "read_errors_uncorrected": read_u,
        "write_errors_uncorrected": write_u,
        "attributes": attributes,
        "source": if is_nvme { "nvme" } else { "native" },
    }))
}

/// Enumerate physical disks natively by probing `\\.\PHYSICALDRIVE0..31` —
/// no PowerShell/WMI subprocess. Read-only open succeeds without admin.
#[cfg(target_os = "windows")]
pub(crate) fn native_list_disks() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for i in 0..32u32 {
        let Some(report) = native_smart_report(&i.to_string()) else {
            continue;
        };
        let model = report["model"].as_str().unwrap_or("").to_string();
        let bus = report["interface"].as_str().unwrap_or("").to_string();
        out.push(serde_json::json!({
            "id": i,
            "name": if model.is_empty() { format!("Disk {}", i) } else { model.clone() },
            "media_type": report["media_type"].as_i64().unwrap_or(-1),
            "health": report["health"].as_i64().unwrap_or(0),
            "operational_status": "OK",
            "size": report["capacity"].as_u64().unwrap_or(0),
            "model": model,
            "serial": report["serial"].as_str().unwrap_or(""),
            "bus_type": bus,
            "spindle_speed": 0,
            "firmware": "",
        }));
    }
    out
}

/// Minimal S.M.A.R.T. report from WMI (MSFT_PhysicalDisk) — works as a normal
/// user. Used as a fallback when the physical drive can't be opened without
/// admin rights. `source` is "wmi" so the UI can offer a privileged restart.
#[cfg(target_os = "windows")]
fn smart_from_wmi(device_id: &str) -> Option<serde_json::Value> {
    let script = format!(
        "try {{ $d = Get-CimInstance -ClassName MSFT_PhysicalDisk -Namespace 'root\\Microsoft\\Windows\\Storage' -Filter \"DeviceId = {id}\"; if (-not $d) {{ '{{}}'; exit 0 }}; $d | Select-Object DeviceId, FriendlyName, MediaType, HealthStatus, OperationalStatus, Size, Model, SerialNumber, BusType, FirmwareVersion | ConvertTo-Json -Compress }} catch {{ '{{}}' }}",
        id = device_id
    );
    let s = crate::cmds::system::win_powershell(&script)?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    if !v.is_object() || v.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        return None;
    }
    let health_status = v["HealthStatus"].as_i64().unwrap_or(5);
    let health_ok = health_status == 0; // 0 = Healthy
    let bus: i64 = v["BusType"].as_i64().unwrap_or(0);
    let interface = match bus {
        17 => "NVMe", 11 => "SATA", 10 => "SAS", 7 => "USB", 3 => "ATA",
        8 => "RAID", 9 => "iSCSI", 12 => "SD", 13 => "MMC", 18 => "SCM",
        _ => "Unknown",
    };
    Some(serde_json::json!({
        "device_id": device_id,
        "friendly_name": v["FriendlyName"],
        "model": v["Model"],
        "serial": v["SerialNumber"],
        "firmware": v["FirmwareVersion"],
        "interface": interface,
        "media_type": v["MediaType"],
        "capacity": v["Size"],
        "health": 0,
        "score": if health_ok { 100 } else { 55 },
        "status": if health_ok { "Healthy" } else { "Warning" },
        "temperature_c": null,
        "wear": null,
        "power_on_hours": 0,
        "power_cycles": null,
        "percentage_used": null,
        "available_spare": null,
        "media_errors": null,
        "read_errors_uncorrected": 0,
        "write_errors_uncorrected": 0,
        "attributes": [],
        "source": "wmi",
    }))
}

#[tauri::command]
pub fn get_smart_status(state: State<AppState>, device_id: String) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        let _ = &state;
        // 100% native via DeviceIoControl — no smartctl / PowerShell subprocess.
        match native_smart_report(&device_id) {
            Some(r) => JsonResult::ok(r),
            // Without admin rights the physical drive can't be opened. Fall back
            // to a silent WMI query (works as a normal user) so the tool still
            // shows basic identification/health, and the UI offers a "Run as
            // Administrator" restart for the full S.M.A.R.T. attribute table.
            None => match smart_from_wmi(&device_id) {
                Some(r) => JsonResult::ok(r),
                None => JsonResult::err(
                    "S.M.A.R.T. data not available (need admin rights to open the physical drive)",
                ),
            },
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Cache pkexec results (success AND failure) for 5 minutes so we
        // don't prompt for the admin password on every scan.
        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
        {
            let cache = state.smart_cache.lock();
            if let Some((when, cached)) = cache.get(&device_id) {
                if when.elapsed() < CACHE_TTL {
                    return cached.clone();
                }
            }
        }
        let result = if let Some(s) = run_smartctl_linux(&device_id) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                smart_from_smartctl(&v, &device_id)
            } else {
                None
            }
        } else {
            None
        };
        let out = match result {
            Some(r) => JsonResult::ok(r),
            None => JsonResult::err(
                "S.M.A.R.T. data not available (is smartmontools installed, and does this disk support SMART?)",
            ),
        };
        state
            .smart_cache
            .lock()
            .insert(device_id.clone(), (std::time::Instant::now(), out.clone()));
        out
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &state;
        if in_mac_sandbox() {
            return JsonResult::err(
                "S.M.A.R.T. is unavailable in the sandboxed App Store build.",
            );
        }
        if let Some(s) = run_output("smartctl", &["-j", "-a", &device_id]) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(r) = smart_from_smartctl(&v, &device_id) {
                    return JsonResult::ok(r);
                }
            }
        }
        JsonResult::err("S.M.A.R.T. data not available (is smartmontools installed?)")
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        JsonResult::err("Unsupported platform")
    }
}

