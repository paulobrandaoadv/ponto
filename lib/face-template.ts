import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isFaceDescriptor } from '@/lib/face-shared';

const keyVersion = 1;

type FaceTemplateOwner = {
  employeeId: string;
  userId: string;
  companyId: string;
};

const templateAad = ({ employeeId, userId, companyId }: FaceTemplateOwner) =>
  Buffer.from(`${employeeId}:${userId}:${companyId}`, 'utf8');

function encryptionKey() {
  const encoded = process.env.FACE_TEMPLATE_ENCRYPTION_KEY;
  if (!encoded || !/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error('FACE_TEMPLATE_ENCRYPTION_KEY deve conter exatamente 64 caracteres hexadecimais.');
  }
  return Buffer.from(encoded, 'hex');
}

export function encryptFaceTemplate(descriptor: number[], owner: FaceTemplateOwner) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(templateAad(owner));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(descriptor), 'utf8'),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

export function decryptFaceTemplate(template: {
  employee_id: string;
  user_id: string;
  company_id: string;
  template_ciphertext: string;
  template_iv: string;
  template_auth_tag: string;
  key_version: number;
}) {
  if (template.key_version !== keyVersion) {
    throw new Error(`Versão de chave facial não suportada: ${template.key_version}.`);
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(template.template_iv, 'base64'),
  );
  decipher.setAAD(templateAad({
    employeeId: template.employee_id,
    userId: template.user_id,
    companyId: template.company_id,
  }));
  decipher.setAuthTag(Buffer.from(template.template_auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(template.template_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const descriptor: unknown = JSON.parse(plaintext);
  if (!isFaceDescriptor(descriptor)) {
    throw new Error('O modelo facial armazenado não é válido.');
  }
  return descriptor;
}

export function cosineSimilarity(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}
