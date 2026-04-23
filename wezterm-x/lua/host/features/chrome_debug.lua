return function(runtime)
  return {
    category = 'chrome',
    recover_reason_prefix = 'chrome',
    failure_notification = {
      title = 'WezTerm Alt+b',
      message = 'Windows helper failed to focus debug Chrome. Check wezterm diagnostics.',
    },
    request = function(trace_id, payload)
      return runtime:write_request(trace_id, 'chrome', 'chrome', 'focus_or_start', function(_)
        local parts = {
          '{',
          '"chrome_path":', runtime:json_escape(payload.executable), ',',
          '"remote_debugging_port":', tostring(payload.remote_debugging_port), ',',
          '"user_data_dir":', runtime:json_escape(payload.user_data_dir), ',',
          '"headless":', (payload.headless and 'true' or 'false'),
        }
        if payload.state_file and payload.state_file ~= '' then
          parts[#parts + 1] = ','
          parts[#parts + 1] = '"state_file":'
          parts[#parts + 1] = runtime:json_escape(payload.state_file)
        end
        parts[#parts + 1] = '}'
        return table.concat(parts)
      end)
    end,
  }
end
