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

    // Format an ISO-local timestring (e.g. "2026-09-15T13:47:00-07:00") as "1:47 PM"
    // WITHOUT reinterpreting it in the server's own timezone â the offset in the
    // string is already the airport's local time, so we just read the HH:MM directly.
    function formatLocalTime(isoStr) {
      if (!isoStr) return null;
      const m = isoStr.match(/T(\d{2}):(\d{2})/);
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
    const depBest = dep.actualTimeLocal || dep.revisedTimeLocal || dep.scheduledTimeLocal || dep.scheduledTime || null;
    const arrBest = arr.actualTimeLocal || arr.revisedTimeLocal || arr.scheduledTimeLocal || arr.scheduledTime || null;

    if (rawStatus.indexOf('cancel') !== -1) {
      result = 'cancelled';
    } else if (rawStatus.indexOf('land') !== -1) {
      result = 'landed';
    } else {
      const scheduled = dep.scheduledTimeLocal || dep.scheduledTime || null;
      const revised = dep.revisedTimeLocal || dep.actualTimeLocal || null;

      if (scheduled && revised) {
        const schedMs = Date.parse(scheduled);
        const revMs = Date.parse(revised);
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
        'Cache-Control': 'public, max-age=300' // 5 min â plenty fresh, saves quota
      },
      body: JSON.stringify({
        status: result,
        delayMinutes,
        raw: entry.status || null,
        departureTime: formatLocalTime(depBest),
        arrivalTime: formatLocalTime(arrBest)
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
