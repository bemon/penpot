/**
 * Part of the Penpot API needed to switch the active page.
 */
export interface PageSwitcher {
    readonly currentPage: { id: string } | null;
    openPage(pageId: string): Promise<void>;
}

/**
 * Makes the given page active, if it is not already.
 *
 * Penpot only lets plugins modify the active page, so tasks for another page switch to it first.
 *
 * @param penpotApi - the Penpot API
 * @param pageId - the ID of the page to activate; nothing happens if omitted
 */
export async function activatePage(penpotApi: PageSwitcher, pageId: string | undefined): Promise<void> {
    if (pageId && penpotApi.currentPage?.id !== pageId) {
        await penpotApi.openPage(pageId);
    }
}
