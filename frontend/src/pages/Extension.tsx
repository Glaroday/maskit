/** 浏览器扩展（独立页）：直接渲染设置页的浏览器扩展 tab 内容（URL 保持 #/extension） */
import SettingsPage from '@/pages/Settings'

export default function ExtensionPage() {
  return <SettingsPage embeddedTab="extension" />
}
