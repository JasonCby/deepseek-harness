/**
 * The Feishu bot's card: its transport, its app identity, and the app secret —
 * which is written through the credentials domain, never into the settings
 * section, so the literal never rides a response.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { FeishuCardFace } from './feishu-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Feishu card. */
export type FeishuCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<FeishuCardFace>

/**
 * Render the Feishu card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function FeishuCard(props: FeishuCardProps) {
  const { t } = props
  const state = props.useFeishuCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="feishuTitle"
      descriptionKey="feishuDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-feishu-transport"
        label={t('feishuTransport')}
        hint={t('feishuTransportHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('feishuInvalidValue')}
        disabled={disabled}
        {...state.transport}
        onEdit={(text) => { props.edit('transport', text) }}
        onReset={() => { props.resetField('transport') }}
      />
      <ValueField
        id="plugin-config-feishu-domain"
        label={t('feishuDomain')}
        hint={t('feishuDomainHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('feishuInvalidValue')}
        disabled={disabled}
        {...state.domain}
        onEdit={(text) => { props.edit('domain', text) }}
        onReset={() => { props.resetField('domain') }}
      />
      <ValueField
        id="plugin-config-feishu-app-id"
        label={t('feishuAppId')}
        hint={t('feishuAppIdHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('feishuInvalidValue')}
        disabled={disabled}
        {...state.appId}
        onEdit={(text) => { props.edit('appId', text) }}
        onReset={() => { props.resetField('appId') }}
      />
      <SecretField
        id="plugin-config-feishu-app-secret"
        label={t('feishuAppSecret')}
        hint={t('feishuAppSecretHint')}
        disabled={!state.appSecretWritable}
        text={state.appSecret.text}
        configured={state.appSecretConfigured}
        stateLabel={state.appSecretConfigured ? t('feishuAppSecretSet') : t('feishuAppSecretUnset')}
        onEdit={(text) => { props.edit('appSecret', text) }}
      />
      <ValueField
        id="plugin-config-feishu-allow-chats"
        label={t('feishuAllowChatIds')}
        hint={t('feishuAllowChatIdsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('feishuInvalidValue')}
        disabled={disabled}
        {...state.allowChatIds}
        onEdit={(text) => { props.edit('allowChatIds', text) }}
        onReset={() => { props.resetField('allowChatIds') }}
      />
    </PluginCard>
  )
}
