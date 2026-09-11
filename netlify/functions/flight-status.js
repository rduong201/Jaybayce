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
//   {
//     status: "on_time" | "early" | "delayed" | "cancelled" | "landed" | "unknown",  // overall badge
//     raw: string | null,
//     departure: { time: "1:25 PM"|null, status: "on_time"|"early"|"delayed"|"unknown", locked: boolean },
//     arrival:   { time: "2:52 PM"|null, status: "on_time"|"early"|"delayed"|"unknown", locked: boolean }
//   }
//
// "locked" means AeroDataBox has reported an ACTUAL (not just predicted) time for
// that leg — i.e. the plane genuinely departed or genuinely landed. Once locked,
// the page stops overwriting that leg's time/color, even if later polls' overall
// status changes for other reasons.

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

    const emptyLeg = { time: null, status: 'unknown', locked: false };
    if (!entry) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unknown', raw: null, departure: emptyLeg, arrival: emptyLeg })
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

    // Format a local timestring as "1:47 PM" — reads the HH:MM directly rather than
    // reinterpreting it in the server's own timezone (the value is already the
    // airport's local wall-clock time).
    function formatLocalTime(rawStr) {
      if (!rawStr || typeof rawStr !== 'string') return null;
      const m = rawStr.match(/[T ](\d{2}):(\d{2})/);
      if (!m) return null;
      let hour = parseInt(m[1], 10);
      const minute = m[2];
      const ampm = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12;
      if (hour === 0) hour = 12;
      return hour + ':' + minute + ' ' + ampm;
    }

    // Compute one leg (departure or arrival) independently: whether it's actually
    // happened yet (locked), the best-known time to display, and on_time/early/
    // delayed relative to the original schedule.
    function computeLeg(leg) {
      leg = leg || {};
      const scheduledStr = extractLocalTimeString(leg.scheduledTime) || extractLocalTimeString(leg.scheduledTimeLocal) || null;
      const actualStr = extractLocalTimeString(leg.actualTime) || extractLocalTimeString(leg.runwayTime) ||
                         extractLocalTimeString(leg.actualTimeLocal) || null;
      const revisedStr = extractLocalTimeString(leg.revisedTime) || extractLocalTimeString(leg.revisedTimeLocal) || null;

      const locked = !!actualStr; // an ACTUAL time means this leg genuinely happened
      const bestStr = actualStr || revisedStr || scheduledStr;
      const time = formatLocalTime(bestStr);

      let status = 'unknown';
      const compareStr = actualStr || revisedStr;
      if (compareStr && scheduledStr) {
        const schedMs = Date.parse(scheduledStr);
        const compMs = Date.parse(compareStr);
        if (!isNaN(schedMs) && !isNaN(compMs)) {
          const diffMin = Math.round((compMs - schedMs) / 60000);
          if (diffMin > 10) status = 'delayed';
          else if (diffMin < -10) status = 'early';
          else status = 'on_time';
        }
      } else if (scheduledStr) {
        status = 'on_time'; // no revision/actual info yet — assume on schedule
      }

      return { time, status, locked };
    }

    const rawStatus = (entry.status || '').toLowerCase();
    const departure = computeLeg(entry.departure);
    const arrival = computeLeg(entry.arrival);

    // Overall badge: cancelled takes priority, then landed (arrival actually happened),
    // otherwise reflects departure's live status.
    let overall = departure.status === 'unknown' ? 'on_time' : departure.status;
    if (arrival.locked) overall = 'landed';
    if (rawStatus.indexOf('cancel') !== -1) overall = 'cancelled';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // 5 min — plenty fresh, saves quota
      },
      body: JSON.stringify({
        status: overall,
        raw: entry.status || null,
        departure,
        arrival
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
