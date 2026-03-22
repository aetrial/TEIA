import axios from 'axios';
import { DateTime } from 'luxon';

const LOG_PREFIX = '[Cal]';

/**
 * Transforms Cal.com slot data to a more usable format.
 */
const transformBusyDates = (slots, timeZone) => {
  return Object.entries(slots).flatMap(([date, times]) => {
    return times.map(({ time }) => {
      const startInZone = DateTime.fromISO(time, { zone: 'utc' }).setZone(timeZone);
      return {
        time: startInZone.toISO(),
      };
    });
  });
};

/**
 * Checks availability on Cal.com for a given date range.
 *
 * @param {object} params
 * @param {string} params.dateFrom - Start date (ISO format)
 * @param {string} params.dateTo - End date (ISO format)
 * @param {string} params.calApiKey - Cal.com API key
 * @param {string} params.calUserId - Cal.com user ID
 * @param {string} params.calEventId - Cal.com event type ID
 * @returns {Promise<object>} Available slots
 */
export const checkAvailability = async ({ dateFrom, dateTo, calApiKey, calUserId, calEventId }) => {
  console.log(`${LOG_PREFIX} checkAvailability: dateFrom=${dateFrom}, dateTo=${dateTo}`);

  if (!calApiKey || !calEventId) {
    console.error(`${LOG_PREFIX} Missing Cal.com credentials`);
    throw new Error("Cal.com credentials not provided");
  }

  try {
    // Convert dates to UTC
    const dateFromUTC = new Date(dateFrom);
    const dateToUTC = new Date(dateTo);

    const response = await axios.get('https://api.cal.com/v1/slots', {
      params: {
        startTime: dateFromUTC,
        endTime: dateToUTC,
        eventTypeId: calEventId,
        apiKey: calApiKey
      }
    });

    const transformedSlots = transformBusyDates(response.data.slots, response.data.timeZone);

    return {
      ...response.data,
      slots: transformedSlots
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error checking availability:`, error.response?.data || error.message);
    throw error;
  }
};

/**
 * Creates a booking on Cal.com.
 *
 * @param {object} params
 * @param {string} params.dateFrom - Start time (ISO format)
 * @param {string} params.dateTo - End time (ISO format)
 * @param {object} params.responses - Booking form responses (name, email, etc.)
 * @param {string} params.calApiKey - Cal.com API key
 * @param {string} params.calUserId - Cal.com user ID
 * @param {string} params.calEventId - Cal.com event type ID
 * @returns {Promise<object>} Booking result
 */
export const createBooking = async ({ dateFrom, dateTo, responses, calApiKey, calUserId, calEventId }) => {
  console.log(`${LOG_PREFIX} createBooking: dateFrom=${dateFrom}, dateTo=${dateTo}`);

  if (!calApiKey || !calEventId) {
    console.error(`${LOG_PREFIX} Missing Cal.com credentials`);
    throw new Error("Cal.com credentials not provided");
  }

  try {
    const eventTypeIdInt = parseInt(calEventId, 10);

    const response = await axios.post(
      `https://api.cal.com/v1/bookings?apiKey=${calApiKey}`,
      {
        responses,
        start: dateFrom,
        end: dateTo,
        eventTypeId: eventTypeIdInt,
        timeZone: "America/Bogota",
        language: "en",
        location: "",
        metadata: {},
        hasHashedBookingLink: false,
        hashedLink: null
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;

  } catch (error) {
    if (error.response?.data?.message === 'no_available_users_found_error') {
      console.warn(`${LOG_PREFIX} No available users for booking`);
      return { error: 'no_available_users_found_error' };
    }
    console.error(`${LOG_PREFIX} Error creating booking:`, error.response?.data || error.message);
    throw error;
  }
};
