/* Hustl configuration.
   SUPABASE_ANON_KEY is the PUBLIC key (the "publishable" / anon key). It ships to every browser by design;
   Row Level Security in supabase.sql is what protects the data.
   Never put the service_role / secret key in this file. */
window.HUSTL_CONFIG = {
  SUPABASE_URL: 'https://wbkxegadcepibvluryqx.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_HbK_ni7Xwc63bKJ67sLwGQ_011dyhNr',
  // Public key for push notifications (reminder alarms that arrive even when Hustl is closed).
  // Its private half is only stored in Supabase (Edge Function secrets), never here.
  VAPID_PUBLIC_KEY: 'BIasFeRxbeJEDXQWMdvBW6jrIf4-tx2iqw99gjJ396dQNpXMk9YVyWcNdubZkYDELKt-ocQqESXumxGaUHoYimA',
};
