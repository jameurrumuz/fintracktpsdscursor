'use client';

import { db, getDb } from '@/lib/firebase';
import { Party, Transaction, Account, InventoryItem, VerificationResult, DepositChannel, AppSettings } from '@/types';
import { 
  collection, getDocs, doc, query, orderBy, limit as firestoreLimit, 
  onSnapshot, writeBatch, runTransaction, serverTimestamp, where, 
  DocumentSnapshot, deleteField, Transaction as FirestoreTransaction, 
  getDoc, Timestamp, arrayUnion, addDoc, deleteDoc, updateDoc,
  DocumentReference
} from 'firebase/firestore';
import { getPartyBalanceEffect, getEffectiveAmount, cleanUndefined, formatDate, formatAmount } from '@/lib/utils';
import { getInventoryEffect, recalculateStockForItem } from './inventoryService';
import { getAppSettings, saveAppSettings } from './settingsService';
import { addLogRecord } from './logRecordService';
import { format as formatFns, parseISO, parse, isValid } from 'date-fns';
import { sendSmsViaSmsq } from './smsqService';
import { sendSmsViaTwilio } from './twilioService';
import { sendSmsViaPushbullet } from './pushbulletService';

const getTransactionsCollection = () => {
    if (!db) return null;
    return collection(db, 'transactions');
}
const getAccountsCollection = () => {
    if (!db) return null;
    return collection(db, 'accounts');
}
const getPartiesCollection = () => {
    if (!db) return null;
    return collection(db, 'parties');
}
const getInventoryCollection = () => {
    if (!db) return null;
    return collection(db, 'inventory');
}

export async function getAccountSnaps(
  fbTransaction: FirestoreTransaction,
  accountIds: string[]
): Promise<Map<string, DocumentSnapshot>> {
  const accountsCollection = getAccountsCollection();
  if (!accountsCollection) return new Map();
  const snaps = new Map<string, DocumentSnapshot>();
  const promises = Array.from(new Set(accountIds)).map(id => {
    if (!id) return Promise.resolve();
    const ref = doc(accountsCollection, id);
    return fbTransaction.get(ref).then(snap => snaps.set(id, snap));
  });
  await Promise.all(promises);
  return snaps;
}

export async function getItemSnaps(
  fbTransaction: FirestoreTransaction,
  itemIds: string[]
): Promise<Map<string, DocumentSnapshot>> {
  const inventoryCollection = getInventoryCollection();
  if (!inventoryCollection) return new Map();
  const snaps = new Map<string, DocumentSnapshot>();
  const promises = Array.from(new Set(itemIds)).map(id => {
    if (!id) return Promise.resolve();
    const ref = doc(inventoryCollection, id);
    return fbTransaction.get(ref).then(snap => snaps.set(id, snap));
  });
  await Promise.all(promises);
  return snaps;
}

const mapDocToTransaction = (doc: DocumentSnapshot): Transaction => {
    const data = doc.data();
    return {
        id: doc.id,
        ...data,
        date: data?.date || '',
        createdAt: (data?.createdAt as Timestamp)?.toDate ? (data?.createdAt as Timestamp).toDate().toISOString() : (data?.createdAt || ''),
    } as Transaction;
};

export function subscribeToAllTransactions(
  onUpdate: (transactions: Transaction[]) => void,
  onError: (error: Error) => void
) {
  const transactionsCollection = getTransactionsCollection();
  if (!transactionsCollection) {
    const error = new Error('Firebase is not configured correctly.');
    onError(error);
    return () => {};
  }

  const q = query(transactionsCollection);

  const unsubscribe = onSnapshot(q, (snapshot) => {
    const transactions = snapshot.docs.map(mapDocToTransaction);
    transactions.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        if(dateA !== dateB) return dateB - dateA;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
    });
    onUpdate(transactions);
  }, (error) => {
    console.error("Error listening to all transactions snapshot:", error);
    onError(error as Error);
  });

  return unsubscribe;
}

export async function addTransaction(
    transactionData: Partial<Transaction> & { cart?: any[] }
): Promise<string> {
    if (!db) throw new Error('Firebase is not configured.');

    const transactionsCollection = collection(db, 'transactions');
    const partiesCollection = collection(db, 'parties');
    const accountsCollection = getAccountsCollection()!;
    const inventoryCollection = getInventoryCollection()!;

    const { cart, ...baseData } = transactionData;
    let mainTxId = '';
    
    let partyDataForSms: Party | null = null;
    let initialPartyBalance = 0;
    
    await runTransaction(db, async (fbTransaction) => {
        let partyRef: DocumentReference | null = null;
        if (baseData.partyId) {
            partyRef = doc(partiesCollection, baseData.partyId);
            const partySnap = await fbTransaction.get(partyRef);
            if (partySnap.exists()) {
                partyDataForSms = { id: partySnap.id, ...(partySnap.data() as Omit<Party, 'id'>) };
                initialPartyBalance = (partySnap.data() as Party).balance || 0;
            }
        }
        
        const accountIds = new Set<string>();
        if (baseData.payments) baseData.payments.forEach(p => accountIds.add(p.accountId));
        if (baseData.accountId) accountIds.add(baseData.accountId);
        if (baseData.fromAccountId) accountIds.add(baseData.fromAccountId);
        if (baseData.toAccountId) accountIds.add(baseData.toAccountId);
        
        const accountSnaps = await getAccountSnaps(fbTransaction, Array.from(accountIds));

        const itemIds = new Set<string>();
        if (cart) cart.forEach(item => { if (item.id && !item.isService) itemIds.add(item.id) });
        const itemSnaps = await getItemSnaps(fbTransaction, Array.from(itemIds));

        let runningPartyBalance = initialPartyBalance;

        const saleRef = doc(transactionsCollection);
        mainTxId = saleRef.id;
        const saleTxData = cleanUndefined({ ...baseData, createdAt: serverTimestamp(), enabled: true }) as Omit<Transaction, 'id'>;
        fbTransaction.set(saleRef, saleTxData);
        
        const saleTxEffect = getPartyBalanceEffect(saleTxData as Transaction, false);
        runningPartyBalance += saleTxEffect;

        if (cart) {
            for (const item of cart) {
                const itemSnap = itemSnaps.get(item.id);
                if (itemSnap?.exists()) {
                    const itemData = itemSnap.data() as InventoryItem;
                    const location = item.location || 'default';
                    const qty = item.sellQuantity || 0;
                    const newStock = { ...(itemData.stock || {}), [location]: (itemData.stock?.[location] || 0) - qty };
                    fbTransaction.update(itemSnap.ref, { quantity: (itemData.quantity || 0) - qty, stock: newStock });
                }
            }
        }
        
        const paidAmount = (baseData.payments || []).reduce((sum, p) => sum + p.amount, 0);

        if (saleTxData.type === 'credit_sale' && paidAmount > 0) {
            for (const payment of baseData.payments!) {
                const accountSnap = accountSnaps.get(payment.accountId);
                if (accountSnap?.exists()) {
                    fbTransaction.update(accountSnap.ref, { balance: (accountSnap.data()!.balance || 0) + payment.amount });
                }
                const receiveTx = cleanUndefined({
                    date: baseData.date, createdAt: serverTimestamp(), type: 'receive',
                    partyId: baseData.partyId, accountId: payment.accountId,
                    amount: payment.amount, description: `Part-payment for Inv: ${baseData.invoiceNumber || ''}`,
                    via: baseData.via, enabled: true,
                });
                const receiveRef = doc(transactionsCollection);
                fbTransaction.set(receiveRef, receiveTx);
                runningPartyBalance += getPartyBalanceEffect(receiveTx as Transaction, false);
            }
        } else if (saleTxData.type === 'sale' && baseData.payments) {
             for (const payment of baseData.payments!) {
                if (payment.amount > 0) {
                    const accountSnap = accountSnaps.get(payment.accountId);
                    if (accountSnap?.exists()) {
                        fbTransaction.update(accountSnap.ref, { balance: (accountSnap.data()!.balance || 0) + payment.amount });
                    }
                }
            }
        } else if (baseData.accountId) {
             const accountSnap = accountSnaps.get(baseData.accountId);
             if (accountSnap?.exists()) {
                 fbTransaction.update(accountSnap.ref, { balance: (accountSnap.data()!.balance || 0) + getEffectiveAmount(saleTxData as Transaction) });
             }
        }
        
        if (partyRef) {
            fbTransaction.update(partyRef, { balance: runningPartyBalance });
        }
    });
    
    if (partyDataForSms && baseData.sendSms !== false) {
        try {
            const saleTransactionForSms: Transaction = { ...baseData, id: mainTxId } as Transaction;
            const paidAmountForSms = (baseData.payments || []).reduce((sum, p) => sum + p.amount, 0) || 0;
            await handleSmsNotification(saleTransactionForSms, partyDataForSms, paidAmountForSms, initialPartyBalance); 
        } catch (error) {
            console.error("SMS notification failed:", error);
        }
    }

    return mainTxId;
}

export async function recalculateBalancesFromTransaction(startDate = '1970-01-01'): Promise<void> {
    const db = getDb();
    if (!db) throw new Error("Firebase not configured");

    const [accountsSnapshot, partiesSnapshot, transactionsSnapshot] = await Promise.all([
        getDocs(query(collection(db, 'accounts'))),
        getDocs(query(collection(db, 'parties'))),
        getDocs(query(collection(db, 'transactions')))
    ]);

    const transactions = transactionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Transaction));
    
    const sortedTransactions = transactions.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        if (dateA !== dateB) return dateA - dateB;
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeA - timeB;
    });

    const accountBalances = new Map<string, number>();
    accountsSnapshot.forEach(doc => accountBalances.set(doc.id, 0));
    const partyBalances = new Map<string, number>();
    partiesSnapshot.forEach(doc => partyBalances.set(doc.id, 0));

    sortedTransactions.forEach(tx => {
        if (!tx.enabled) return;
        if (tx.type === 'transfer') {
            if (tx.fromAccountId && accountBalances.has(tx.fromAccountId)) accountBalances.set(tx.fromAccountId, (accountBalances.get(tx.fromAccountId) || 0) - tx.amount);
            if (tx.toAccountId && accountBalances.has(tx.toAccountId)) accountBalances.set(tx.toAccountId, (accountBalances.get(tx.toAccountId) || 0) + tx.amount);
        } else if (tx.payments && tx.payments.length > 0) {
            tx.payments.forEach(p => {
                if (accountBalances.has(p.accountId)) accountBalances.set(p.accountId, (accountBalances.get(p.accountId) || 0) + p.amount);
            });
        } else if (tx.accountId) {
            const effect = getEffectiveAmount(tx);
            if (effect !== 0 && accountBalances.has(tx.accountId)) accountBalances.set(tx.accountId, (accountBalances.get(tx.accountId) || 0) + effect);
        }
        if (tx.partyId && partyBalances.has(tx.partyId)) {
            const currentPartyBalance = partyBalances.get(tx.partyId) || 0;
            const partyEffect = getPartyBalanceEffect(tx);
            partyBalances.set(tx.partyId, currentPartyBalance + partyEffect);
        }
    });
    
    const batch = writeBatch(db);
    accountBalances.forEach((balance, accountId) => batch.update(doc(db, 'accounts', accountId), { balance }));
    partyBalances.forEach((balance, partyId) => batch.update(doc(db, 'parties', partyId), { balance }));
    await batch.commit();
}

export async function updateTransaction(id: string, updatedData: Partial<Omit<Transaction, 'id'>>): Promise<void> {
    const db = getDb();
    if (!db) throw new Error("Firebase not configured.");
    await updateDoc(doc(db, 'transactions', id), { ...cleanUndefined(updatedData), updatedAt: serverTimestamp() });
    await recalculateBalancesFromTransaction();
}

export async function toggleTransaction(id: string, enabled: boolean): Promise<void> {
    if (!db) throw new Error("Firebase not configured.");
    await updateDoc(doc(db, 'transactions', id), { enabled });
    await recalculateBalancesFromTransaction();
}

export async function deleteTransaction(id: string): Promise<void> {
    if (!db) throw new Error("Firebase not configured.");
    await deleteDoc(doc(db, 'transactions', id));
    await recalculateBalancesFromTransaction();
}

function calculateFifoCost(
  costHistory: { date: string; quantity: number; cost: number }[],
  quantitySold: number
): { updatedCostHistory: any[]; totalCostForSale: number; costPerUnit: number } {
  if (!costHistory || costHistory.length === 0) {
    return { updatedCostHistory: [], totalCostForSale: 0, costPerUnit: 0 };
  }
  let totalCostForSale = 0;
  let remainingQtyToSell = quantitySold;
  const sortedHistory = [...costHistory].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const updatedHistory = [];

  for (const batch of sortedHistory) {
    if (remainingQtyToSell <= 0) {
      updatedHistory.push(batch);
      continue;
    }
    const qtyFromThisBatch = Math.min(remainingQtyToSell, batch.quantity);
    totalCostForSale += qtyFromThisBatch * batch.cost;
    remainingQtyToSell -= qtyFromThisBatch;
    const remainingInBatch = batch.quantity - qtyFromThisBatch;
    if (remainingInBatch > 0) {
      updatedHistory.push({ ...batch, quantity: remainingInBatch });
    }
  }
  const costPerUnit = quantitySold > 0 ? totalCostForSale / quantitySold : 0;
  return { updatedCostHistory: updatedHistory, totalCostForSale, costPerUnit };
}

export async function recalculateAllFifoAndProfits(): Promise<{ updatedItems: number; updatedTransactions: number }> {
  const db = getDb();
  if (!db) throw new Error("Firebase not configured.");
  const [invSnap, txSnap] = await Promise.all([
    getDocs(collection(db, 'inventory')),
    getDocs(query(collection(db, 'transactions'), orderBy('date', 'asc')))
  ]);
  const allItems = new Map<string, InventoryItem>();
  invSnap.forEach(d => allItems.set(d.id, { ...d.data(), id: d.id, quantity: 0, stock: {}, costHistory: [] } as any));
  const batch = writeBatch(db);
  let updatedTxs = 0;
  for (const docSnap of txSnap.docs) {
    const tx = { ...docSnap.data(), id: docSnap.id } as Transaction;
    if (!tx.items || !tx.enabled) continue;
    let needsUpdate = false;
    const newItems = [...tx.items];
    for (let i = 0; i < newItems.length; i++) {
      const item = allItems.get(newItems[i].id);
      if (!item) continue;
      const loc = newItems[i].location || 'default';
      if (['purchase', 'credit_purchase', 'sale_return'].includes(tx.type)) {
        item.quantity += newItems[i].quantity;
        item.stock![loc] = (item.stock![loc] || 0) + newItems[i].quantity;
        item.costHistory!.push({ date: tx.date, quantity: newItems[i].quantity, cost: newItems[i].price });
        item.costHistory!.sort((a,b) => a.date.localeCompare(b.date));
      } else if (['sale', 'credit_sale', 'purchase_return'].includes(tx.type)) {
        const { updatedCostHistory, totalCostForSale } = calculateFifoCost(item.costHistory!, newItems[i].quantity);
        item.quantity -= newItems[i].quantity;
        item.stock![loc] = (item.stock![loc] || 0) - newItems[i].quantity;
        item.costHistory = updatedCostHistory;
        if (Math.abs((newItems[i].cost || 0) - totalCostForSale) > 0.01) {
            newItems[i].cost = totalCostForSale;
            needsUpdate = true;
        }
      }
    }
    if (needsUpdate) {
        batch.update(doc(db, 'transactions', tx.id), { items: newItems });
        updatedTxs++;
    }
  }
  let updatedItems = 0;
  allItems.forEach(item => {
    batch.update(doc(db, 'inventory', item.id), { quantity: item.quantity, stock: item.stock, costHistory: item.costHistory });
    updatedItems++;
  });
  await batch.commit();
  return { updatedItems, updatedTransactions: updatedTxs };
}

export async function handleSmsNotification(
    transaction: Transaction,
    party: Party,
    paidAmount: number = 0,
    previousDue: number
) {
    if (!party.phone || !db) return;

    try {
        const appSettings = await getAppSettings();
        if (!appSettings?.smsServiceEnabled || !Array.isArray(appSettings.smsTemplates)) return;
        
        let templateType: 'cashSale' | 'creditSale' | 'receivePayment' | 'givePayment' | 'creditSaleWithPartPayment' | undefined;
        
        switch (transaction.type) {
            case 'sale':
                templateType = 'cashSale';
                break;
            case 'credit_sale':
                templateType = paidAmount > 0 ? 'creditSaleWithPartPayment' : 'creditSale';
                break;
            case 'receive':
                templateType = 'receivePayment';
                break;
            case 'give':
            case 'spent':
                templateType = 'givePayment';
                break;
        }
        
        if (!templateType) return;

        let template = appSettings.smsTemplates.find(t => t.type === templateType);

        if (!template && templateType === 'creditSaleWithPartPayment') {
            template = appSettings.smsTemplates.find(t => t.type === 'creditSale');
        }

        if (!template || !template.message) return;
        
        const currentBalance = previousDue + getPartyBalanceEffect(transaction, false);
        const businessName = appSettings.businessProfiles.find(p => p.name === transaction.via)?.name || appSettings.businessProfiles[0]?.name || 'our company';
        
        const partyBalanceText = (balance: number) => {
            if (balance > 0.01) return `+${formatAmount(balance, false)}`; 
            if (balance < -0.01) return `-${formatAmount(Math.abs(balance), false)}`; 
            return formatAmount(0, false);
        };

        const previousBalanceStr = partyBalanceText(previousDue);
        const currentBalanceStr = partyBalanceText(currentBalance);
        
        const safeFormatDate = (dateStr: string) => {
            try {
                if (!dateStr) return '';
                const isoDate = parseISO(dateStr);
                if (isValid(isoDate)) return formatFns(isoDate, "dd/MM/yyyy");
                return dateStr;
            } catch (e) {
                return dateStr;
            }
        };

        let message = template.message
            .replace(/{partyName}/g, party.name)
            .replace(/{amount}/g, formatAmount(transaction.amount, false))
            .replace(/{date}/g, safeFormatDate(transaction.date))
            .replace(/{businessName}/g, businessName)
            .replace(/{invoiceNumber}/g, transaction.invoiceNumber?.replace('INV-', '') || '')
            .replace(/{previousDue}/g, previousBalanceStr)
            .replace(/{currentBalance}/g, currentBalanceStr)
            .replace(/{PartPaymentAmount}/g, formatAmount(paidAmount, false));

        const smsProvider = appSettings.smsProvider || 'twilio';
        
        if (smsProvider === 'smsq' && appSettings.smsqApiKey && appSettings.smsqClientId && appSettings.smsqSenderId) {
            await sendSmsViaSmsq(party.phone!, message, appSettings.smsqApiKey, appSettings.smsqClientId, appSettings.smsqSenderId);
        } else if (smsProvider === 'twilio' && appSettings.twilioAccountSid && appSettings.twilioAuthToken && appSettings.twilioMessagingServiceSid) {
            await sendSmsViaTwilio(party.phone!, message, appSettings.twilioAccountSid, appSettings.twilioAuthToken, appSettings.twilioMessagingServiceSid);
        } else if (smsProvider === 'pushbullet' && appSettings.pushbulletAccessToken) {
            await sendSmsViaPushbullet(party.phone!, message, appSettings.pushbulletAccessToken, appSettings.pushbulletDeviceId);
        }
        
    } catch (err) {
        console.warn(`Could not send SMS: `, err);
    }
}

export async function attemptAutoVerification(txRef: string, trxId: string, depositChannels: DepositChannel[], amount: number): Promise<{ isVerified: boolean; accountId?: string }> {
    const settings = await getAppSettings();
    const sheetId = settings?.googleSheetId;
    if (!sheetId) return { isVerified: false };
    try {
        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`;
        const res = await fetch(url, { cache: 'no-store' });
        const text = await res.text();
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.toLowerCase().includes(txRef.toLowerCase()) && line.toLowerCase().includes(trxId.toLowerCase())) {
                for (const ch of depositChannels) {
                    if (line.toLowerCase().includes(ch.senderIdentifier.toLowerCase())) return { isVerified: true, accountId: ch.accountId };
                }
            }
        }
    } catch (e) { console.error(e); }
    return { isVerified: false };
}

export async function markOnlineOrdersAsNotified(ids: string[]): Promise<void> {
    const batch = writeBatch(db!);
    ids.forEach(id => batch.update(doc(db!, 'transactions', id), { adminNotified: true }));
    await batch.commit();
}

export async function markTransactionsAsReviewed(ids: string[], note: string): Promise<void> {
    const batch = writeBatch(db!);
    ids.forEach(id => batch.update(doc(db!, 'transactions', id), { suspicionReviewed: true, suspicionReviewNote: note }));
    await batch.commit();
}

export async function subscribeToPendingPayments(onUpdate: (pending: Transaction[]) => void, onError: (error: Error) => void) {
    if (!db) return () => {};
    const q = query(collection(db, 'transactions'), where('paymentStatus', '==', 'pending'));
    return onSnapshot(q, (snap) => onUpdate(snap.docs.map(mapDocToTransaction)), onError);
}

export async function subscribeToNewOnlineOrders(onUpdate: (orders: Transaction[]) => void, onError: (error: Error) => void) {
    if (!db) return () => {};
    const q = query(collection(db, 'transactions'), where('adminNotified', '==', false), where('description', '>=', 'Purchase from Online Store'));
    return onSnapshot(q, (snap) => onUpdate(snap.docs.map(mapDocToTransaction).filter(t => t.description.includes('Online Store'))), onError);
}
