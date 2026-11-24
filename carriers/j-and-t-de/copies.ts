/**
 * J&T Express Germany's rows in German, as the trackers of lines into Germany copy them once it is their
 * destination courier: its scans opening with the district in 【】, its round, its delivery and its record of
 * the order's data.
 */
const COPIED_ROW = /^【[^】]*】.*\b(?:Sendung|Paket)\b|^Die Sendung von 【[^】]*】 in 【[^】]*】 ist unterwegs zur Zustellung\b|^Ihr Paket wurde erfolgreich zugestellt\b|^Die Auftragsdaten für diese Sendung wurden elektronisch an J&T Express übermittelt\b/u;

/** Whether a row a line's tracker shows is J&T Express Germany's, copied in German. */
export const isJAndTGermanyCopy = (description: string): boolean => COPIED_ROW.test(description);

/**
 * The offset of those copies' wall clocks: an hour behind UTC, which gives the instant J&T Express Germany's
 * own tracker gives the same scan, to the second. Read on Berlin's clock, they would come two hours early.
 */
export const J_AND_T_GERMANY_COPY_OFFSET = '-01:00';
