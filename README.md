# Arby's equipment status - design preview

The root page is a static visual example using invented store information. It does not read FORM.com, Tableau, SharePoint, work orders, or any live request. The Inactive link button demonstrates the intended appearance; it does not revoke access to this public demo.

The repository also contains a generic encrypted one-project viewer at `track.html`. It can show a limited set of verified Thirsty work orders and label later project steps **Not confirmed**. This repository currently has no customer project data or issued customer links. The root page remains the invented preview when opened without a project link.

Do not commit customer information, source exports, recipient details, or a decryption key to this repository. Any real project file must be encrypted and issued only after source, recipient, and publication checks. The full project URL is a bearer link: anyone who receives it can open that project's status. Deleting a published file cannot revoke a previously copied URL and ciphertext. The source must be refreshed and checked daily for the first release; the page warns when its last verified data is 24 hours old.
