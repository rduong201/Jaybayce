// netlify/functions/flight-status.js
//
// Server-side proxy for AeroDataBox (via RapidAPI) flight status lookups.
// The RapidAPI key lives only in Netlify's environment variables (RAPIDAPI_KEY)
// and is never sent to or visible from the browser.
//
// Usage from the page:
//   GET /.netlify/functions/flight-status?flight=UA469&date=2026-09-15
//
// Returns:
//   { status: "on_time" | "early" | "delayed" | "cancelled" | "landed" | "unknown",
//     delayMinutes: number | null,
//     raw: string | null }

exports.handler = async function (event) {
  const { flight, date } = event.queryStringParameters || {};

  if (!flight || !date) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required query params: flight, date' })
    };
  }

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Server not configured: RAPIDAPI_KEY missing' })
    };
  }

  try {
    const url = `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(flight)}/${encodeURIComponent(date)}`;

    const upstream = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
      }
    });

    if (!upstream.ok) {
      return {
        statusCode: upstream.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Upstream error', status: upstream.status })
      };
    }

    const data = await upstream.json();
    const entry = Array.isArray(data) ? data[0] : data;

    if (!entry) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unknown', delayMinutes: null, raw: null, departureTime: null, arrivalTime: null })
      };
    }

    // AeroDataBox returns timestamps as either a plain string, or (more commonly)
    // a nested object like { utc: "...", local: "2026-09-15 13:25-07:00" }.
    // This pulls out the local time string regardless of which shape shows up,
    // and never throws on an unexpected type.
    function extractLocalTimeString(field) {
      if (!field) return null;
      if (typeof field === 'string') return field;
      if (typeof field === 'object' && typeof field.local === 'string') return field.local;
      return null;
    }

    // Format a local timestring (e.g. "2026-09-15 13:47-07:00" or "...T13:47:00-07:00")
    // as "1:47 PM" — reads the HH:MM directly rather than reinterpreting it in the
    // server's own timezone (the value is already the airport's local wall-clock time).
    function formatLocalTime(field) {
      const raw = extractLocalTimeString(field);
      if (!raw || typeof raw !== 'string') return null;
      const m = raw.match(/[T ](\d{2}):(\d{2})/);
      if (!m) return null;
      let hour = parseInt(m[1], 10);
      const minute = m[2];
      const ampm = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12;
      if (hour === 0) hour = 12;
      return hour + ':' + minute + ' ' + ampm;
    }

    const rawStatus = (entry.status || '').toLowerCase();
    let result = 'on_time';
    let delayMinutes = null;

    const dep = entry.departure || {};
    const arr = entry.arrival || {};
    const depBestStr = extractLocalTimeString(dep.actualTime) || extractLocalTimeString(dep.runwayTime) ||
                        extractLocalTimeString(dep.revisedTime) || extractLocalTimeString(dep.scheduledTime) ||
                        extractLocalTimeString(dep.actualTimeLocal) || extractLocalTimeString(dep.revisedTimeLocal) ||
                        extractLocalTimeString(dep.scheduledTimeLocal) || null;
    const arrBestStr = extractLocalTimeString(arr.actualTime) || extractLocalTimeString(arr.runwayTime) ||
                        extractLocalTimeString(arr.revisedTime) || extractLocalTimeString(arr.scheduledTime) ||
                        extractLocalTimeString(arr.actualTimeLocal) || extractLocalTimeString(arr.revisedTimeLocal) ||
                        extractLocalTimeString(arr.scheduledTimeLocal) || null;

    if (rawStatus.indexOf('cancel') !== -1) {
      result = 'cancelled';
    } else if (rawStatus.indexOf('land') !== -1) {
      result = 'landed';
    } else {
      const scheduledStr = extractLocalTimeString(dep.scheduledTime) || extractLocalTimeString(dep.scheduledTimeLocal) || null;
      const revisedStr = extractLocalTimeString(dep.revisedTime) || extractLocalTimeString(dep.actualTime) ||
                          extractLocalTimeString(dep.revisedTimeLocal) || extractLocalTimeString(dep.actualTimeLocal) || null;

      if (scheduledStr && revisedStr) {
        const schedMs = Date.parse(scheduledStr);
        const revMs = Date.parse(revisedStr);
        if (!isNaN(schedMs) && !isNaN(revMs)) {
          delayMinutes = Math.round((revMs - schedMs) / 60000);
          if (delayMinutes > 10) result = 'delayed';
          else if (delayMinutes < -10) result = 'early';
          else result = 'on_time';
        }
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // 5 min — plenty fresh, saves quota
      },
      body: JSON.stringify({
        status: result,
        delayMinutes,
        raw: entry.status || null,
        departureTime: formatLocalTime(depBestStr),
        arrivalTime: formatLocalTime(arrBestStr)
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Proxy error', message: String(err) })
    };
  }
};
