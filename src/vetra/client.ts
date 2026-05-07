const CREATE_DOCUMENT = `
  mutation CreateDocument($document: JSONObject!, $parentIdentifier: String) {
    createDocument(document: $document, parentIdentifier: $parentIdentifier) { id name documentType }
  }
`;

const MUTATE_DOCUMENT = `
  mutation MutateDocument($documentIdentifier: String!, $actions: [JSONObject!]!) {
    mutateDocument(documentIdentifier: $documentIdentifier, actions: $actions) { id name revisionsList { scope revision } }
  }
`;

export class VetraClient {
  constructor(private readonly switchboardUrl = process.env.ID_VETRA_SWITCHBOARD_URL ?? "http://127.0.0.1:4001/graphql") {}

  async createDocumentIfMissing(documentId: string) {
    await this.post(CREATE_DOCUMENT, {
      document: { id: documentId, name: documentId, documentType: "kilgore/dispatch" },
      parentIdentifier: process.env.ID_VETRA_PARENT_ID ?? null,
    });
  }

  async mutateDocument(documentId: string, action: Record<string, unknown>) {
    await this.post(MUTATE_DOCUMENT, { documentIdentifier: documentId, actions: [action] });
  }

  private async post(query: string, variables: Record<string, unknown>) {
    const response = await fetch(this.switchboardUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await response.json()) as { errors?: unknown[]; data?: unknown };
    if (!response.ok || json.errors?.length) throw new Error(JSON.stringify(json.errors ?? json));
    return json.data;
  }
}
