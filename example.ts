import * as rules from './conditions';
import * as fields from './fields';
import { collection, relation, subCollection } from './models';
import { useList, useOperation, useResource } from './react/api';
import { uuid4 } from './uuid';

const chats = collection({
    name: 'chats',
    fields: {
        id: fields.uuid(),
        creatorId: fields.string(),
        updaterId: fields.string(),
        name: fields.string(),
        messageCount: fields.integer(),
        createdAt: fields.timestamp(),
        updatedAt: fields.timestamp(),
    },
    identifyBy: ['id'],
});
const messages = subCollection(chats, {
    name: 'messages',
    fields: {
        id: fields.uuid(),
        chatId: fields.uuid(),
        creatorId: fields.string(),
        updaterId: fields.string(),
        message: fields.string(),
        createdAt: fields.timestamp(),
    },
    relation: relation({
        id: 'chatId',
    }),
    identifyBy: ['id'],
});

const userChatList = chats.listable({
    auth: 'user',
    ordering: ['name'],
    properties: {
        creatorId: rules.matchAuthUserId(),
    },
});

const userChatCreate = chats.creatable({
    auth: 'user',
    properties: {
        id: rules.setGenerated(uuid4),
        creatorId: rules.setAuthUserId(),
        updaterId: rules.setAuthUserId(),
        name: rules.required(),
        messageCount: rules.setTo(0),
        createdAt: rules.setTimestamp(),
        updatedAt: rules.setTimestamp(),
    },
});

const userChatUpdate = chats.updateable({
    auth: 'user',
    properties: {
        id: rules.required(),
        creatorId: rules.matchAuthUserId(),
        updaterId: rules.setAuthUserId(),
        name: rules.optional(),
        messageCount: rules.disallowSet(),
        createdAt: rules.disallowSet(),
        updatedAt: rules.setTimestamp(),
    },
});

const userChatDelete = chats.deleteable({
    auth: 'user',
    properties: {
        id: rules.required(),
    },
});

const chatMessageList = messages.listable({
    auth: 'none',
    ordering: ['createdAt'],
    properties: {
        chatId: rules.required(),
    },
});

const chatMessageCreate = messages.creatable({
    auth: 'user',
    properties: {
        id: rules.setGenerated(uuid4),
        chatId: rules.required(),
        creatorId: rules.setAuthUserId(),
        updaterId: rules.setAuthUserId(),
        createdAt: rules.setTimestamp(),
        message: rules.required(),
    },
});

export async function main() {
    // tslint:disable-next-line:no-shadowed-variable
    const chats = useList(userChatList.all({ }, 'name', 'asc'));
    const chat = useResource(userChatList.one({ id: 'asf' }));
    const createChat = useOperation(userChatCreate);
    const updateChat = useOperation(userChatUpdate);
    const deleteChat = useOperation(userChatDelete);
    const created = await createChat({ name: 'Örgh' });
    const chatMessages = useList(chatMessageList.all({ chatId: created.id }, 'createdAt', 'asc'));
    const createChatMessage = useOperation(chatMessageCreate);
    const newMessage = await createChatMessage({ chatId: created.id, message: 'Jou!' });
    const updated = await updateChat({ id: created.id, name: 'Örgh!' });
    await deleteChat({ id: created.id });
    // tslint:disable-next-line:no-console
    console.log(chats, chat, created, updated, chatMessages, newMessage);
}
